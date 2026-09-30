import type { EventBus } from '../shared/bus.js';
import type { BlertEvent } from '../shared/events.js';
import type { Market } from '../shared/types.js';
import { systemClock, type Clock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import { ALLOWED_HOSTS, ENDPOINTS, LIMITS, isAllowedUrl, type Endpoints } from './endpoints.js';
import { ManagedConnection, type ConnState, type WebSocketLike, type WsFactory } from './connection.js';
import { fetchKlineEvents } from './rest.js';
import { parseStreamMessage } from './streams.js';
import { streamsOf, type StreamPlan } from './subscriptions.js';

export { planSubscriptions, type StreamPlan } from './subscriptions.js';
export type { WebSocketLike, WsFactory, ConnState } from './connection.js';

const LOG = 'binance';
const MARKETS: Market[] = ['spot', 'futures'];

export interface FeedOptions {
  bus: EventBus;
  clock?: Clock;
  logger?: Logger;
  /** 테스트용 가짜 소켓. 기본은 Node 내장 WebSocket */
  wsFactory?: WsFactory;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  endpoints?: Endpoints;
  /** 기본은 바이낸스 도메인만 (NFR-SEC-02). 테스트에서만 넓힌다. */
  allowedHosts?: readonly string[];
}

/** 시장 하나의 연결들. 스트림 수가 한도를 넘으면 연결을 나눈다. */
class MarketFeed {
  private shards: ManagedConnection[] = [];
  private assigned = new Map<string, number>();

  constructor(
    private market: Market,
    private create: (name: string) => ManagedConnection,
  ) {}

  setStreams(streams: string[]): void {
    const want = new Set(streams);
    for (const s of [...this.assigned.keys()]) if (!want.has(s)) this.assigned.delete(s);
    const counts = this.shards.map(() => 0);
    for (const i of this.assigned.values()) counts[i] = (counts[i] ?? 0) + 1;
    const cap = LIMITS[this.market].maxStreams;
    for (const s of want) {
      if (this.assigned.has(s)) continue;
      let i = counts.findIndex((c) => c < cap);
      if (i < 0) {
        i = this.shards.length;
        this.shards.push(this.create(i === 0 ? this.market : `${this.market}#${i + 1}`));
        counts.push(0);
      }
      this.assigned.set(s, i);
      counts[i] = (counts[i] ?? 0) + 1;
    }
    this.shards.forEach((shard, i) => {
      shard.setStreams([...this.assigned].filter(([, j]) => j === i).map(([s]) => s));
      if ((counts[i] ?? 0) > 0) shard.start();
      else shard.stop();
    });
  }

  reconnectNow(): void {
    for (const s of this.shards) s.reconnectNow();
  }

  stop(): void {
    for (const s of this.shards) s.stop();
  }

  get status(): { stream: string; state: ConnState; attempt: number }[] {
    return this.shards.map((s) => s.status);
  }
}

/**
 * 바이낸스 공개 스트림(현물·선물)과 REST 백필을 묶어 이벤트로 내보낸다 (B5).
 * 어떤 스트림이 필요한지는 runtime이 규칙에서 계산해 update()로 넘긴다.
 */
export class BinanceFeed {
  private clock: Clock;
  private endpoints: Endpoints;
  private allowedHosts: readonly string[];
  private feeds: Record<Market, MarketFeed>;
  private plan: StreamPlan[] = [];
  private stopped = false;
  private backfillChain: Promise<void> = Promise.resolve();
  private covered = new Map<string, number>();
  private lastOpen = new Map<string, number>();
  private invalid = new Set<string>();
  private malformed = 0;

  constructor(private opts: FeedOptions) {
    this.clock = opts.clock ?? systemClock;
    this.endpoints = opts.endpoints ?? ENDPOINTS;
    this.allowedHosts = opts.allowedHosts ?? ALLOWED_HOSTS;
    const feed = (market: Market) =>
      new MarketFeed(market, (name) =>
        new ManagedConnection({
          name,
          url: this.endpoints.ws[market],
          factory: (url) => this.socket(url),
          clock: this.clock,
          emit: (e) => this.emit(e),
          onData: (stream, data) => this.onData(market, stream, data),
          onReconnected: () => this.backfillMarket(market),
          logger: opts.logger,
        }),
      );
    this.feeds = { spot: feed('spot'), futures: feed('futures') };
  }

  /** 구독 계획을 적용한다. 처음 부르면 연결을 시작하고, 이후에는 구독 목록만 갱신한다. */
  update(plan: StreamPlan[]): void {
    if (this.stopped) return;
    this.plan = plan;
    const keys = new Set(plan.map((p) => `${p.market}:${p.symbol}`));
    for (const k of [...this.invalid]) if (!keys.has(k)) this.invalid.delete(k);
    for (const market of MARKETS) {
      this.feeds[market].setStreams(plan.filter((p) => p.market === market).flatMap(streamsOf));
    }
    for (const p of plan) {
      const key = `${p.market}:${p.symbol}`;
      if (p.kline && p.backfillMs > (this.covered.get(key) ?? 0)) this.queueBackfill(p, this.clock.now() - p.backfillMs, p.backfillMs);
    }
  }

  /** 절전 복귀 등: 모든 연결을 새로 맺는다 */
  reconnectAll(): void {
    for (const market of MARKETS) this.feeds[market].reconnectNow();
  }

  stop(): void {
    this.stopped = true;
    for (const market of MARKETS) this.feeds[market].stop();
  }

  get status(): { stream: string; state: ConnState; attempt: number }[] {
    return MARKETS.flatMap((m) => this.feeds[m].status);
  }

  // ---- 내부 ----

  private socket(url: string): WebSocketLike {
    if (!isAllowedUrl(url, this.allowedHosts)) throw new Error('blocked connection to a non-Binance host');
    return this.opts.wsFactory ? this.opts.wsFactory(url) : (new WebSocket(url) as unknown as WebSocketLike);
  }

  private emit(e: BlertEvent): void {
    if (e.type === 'market.kline') {
      const key = `${e.market}:${e.symbol}`;
      this.lastOpen.set(key, Math.max(this.lastOpen.get(key) ?? 0, Date.parse(e.openTime)));
    }
    this.opts.bus.emit(e);
  }

  private onData(market: Market, stream: string, data: unknown): void {
    const event = parseStreamMessage(market, stream, data, this.clock.now());
    if (event) this.emit(event);
    else if (this.malformed++ < 5) this.opts.logger?.warn(LOG, `unexpected message on ${stream}`);
  }

  /** 끊겼다 다시 열린 시장: 마지막으로 본 분봉부터 다시 채운다 */
  private backfillMarket(market: Market): void {
    for (const p of this.plan) {
      if (p.market !== market || !p.kline || p.backfillMs <= 0) continue;
      const floor = this.clock.now() - p.backfillMs;
      this.queueBackfill(p, Math.max(this.lastOpen.get(`${p.market}:${p.symbol}`) ?? floor, floor), p.backfillMs);
    }
  }

  /** REST 백필은 한 번에 하나씩 순서대로 실행한다 (레이트 리밋 보호) */
  private queueBackfill(p: StreamPlan, fromMs: number, span: number): void {
    const key = `${p.market}:${p.symbol}`;
    if (this.invalid.has(key)) return;
    this.backfillChain = this.backfillChain.then(async () => {
      if (this.stopped) return;
      const res = await fetchKlineEvents(p.market, p.symbol, fromMs, {
        fetchFn: this.opts.fetchFn,
        sleep: this.opts.sleep,
        now: () => this.clock.now(),
        logger: this.opts.logger,
        rest: this.endpoints.rest,
        allowedHosts: this.allowedHosts,
      });
      if (this.stopped) return;
      for (const e of res.events) this.emit(e); // 실패해도 받은 데이터까지는 쓴다
      if (res.ok) this.covered.set(key, Math.max(this.covered.get(key) ?? 0, span));
      else if (res.reason === 'invalid-symbol') this.invalid.add(key);
    });
  }
}
