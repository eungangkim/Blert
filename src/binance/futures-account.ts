import type { EventBus } from '../shared/bus.js';
import type { BlertEvent } from '../shared/events.js';
import { iso, systemClock, type Clock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import { allowedHosts as hostsFor, isAllowedUrl, type NetworkMode } from '../shared/network.js';
import { FUTURES_ACCOUNT_ENDPOINTS, type FuturesAccountEndpoints } from './endpoints.js';
import { OUTAGE_WARN_MS, ROTATE_AFTER_MS, retryDelayMs, type ConnState, type WebSocketLike, type WsFactory } from './connection.js';
import { fetchPositions, listenKeyRequest, type AccountRestOptions, type Position } from './account-rest.js';
import type { AuthorizeResult } from './account.js';

const LOG = 'binance.futures-account';
export const FUTURES_ACCOUNT_STREAM = 'futures-account';
const SEEN_TRADES_MAX = 5000;
/** listenKey는 60분 안에 유지해야 한다. 절반 간격으로 갱신한다 (문서: Start-User-Data-Stream) */
const KEEPALIVE_MS = 30 * 60_000;
/** 청산가는 사용자 데이터 이벤트에 없어서, 이벤트가 올 때와 이 간격마다 포지션을 다시 읽는다 (D-46, D-50) */
const POLL_MS = 15_000;
/** 계정 갱신이 연달아 와도 포지션 조회는 한 번만 하도록 모으는 시간 */
const REFRESH_DEBOUNCE_MS = 500;

/** 현재 규칙이 선물 계정 연결에 요구하는 것 */
export interface FuturesWants {
  /** 체결 알림을 받을 선물 심볼 (D-52: 전체는 없다) */
  fillSymbols: string[];
  /** 청산가 근접 규칙이 있는 심볼 (D-51) */
  liqSymbols: string[];
}

export interface FuturesAccountTiming {
  pollMs: number;
  keepaliveMs: number;
}

export interface FuturesAccountFeedOptions {
  bus: EventBus;
  authorize: () => Promise<AuthorizeResult>;
  wants: () => FuturesWants;
  /** 이 연결을 더는 쓸 수 없을 때(키 거부 등) 한 번 부른다. 재시도하지 않는다. */
  onFatal?: (detail: string) => void;
  clock?: Clock;
  logger?: Logger;
  mode?: NetworkMode;
  endpoints?: FuturesAccountEndpoints;
  allowedHosts?: readonly string[];
  wsFactory?: WsFactory;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timing?: Partial<FuturesAccountTiming>;
}

interface Session {
  socket: WebSocketLike;
  creds: AuthorizeOk;
  dead: boolean;
}
type AuthorizeOk = Extract<AuthorizeResult, { ok: true }>['credentials'];
type TimerName = 'retry' | 'rotate' | 'keepalive' | 'poll' | 'refresh' | 'outageWarn';

const num = (v: unknown): number => (typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN);

/**
 * 선물 사용자 데이터 (v0.3, 체결·포지션). 바이낸스에 listenKey 외의 방식이 없어 선물에 한해 listenKey를 쓴다 (D-45).
 * 문서 링크는 endpoints.ts.
 * - 연결을 시도할 때마다 authorize()로 키를 다시 확인하고(FR-KEY-04) listenKey를 새로 발급받는다.
 * - listenKey는 30분마다 유지(keepalive)하고, 실패하면 다시 연결한다. 24시간 만료 전에도 미리 다시 연결한다.
 * - 연결이 열리면 포지션을 읽고, 이후 계정 갱신 이벤트가 올 때와 15초마다 다시 읽어 청산가를 갱신한다 (D-46).
 * - 한계: 사용자 스트림은 거래가 없으면 조용해서 반쯤 끊긴 연결을 바로 알아채지 못한다. keepalive 실패나 소켓 종료로 알게 되고,
 *   그동안에도 청산가는 15초 주기 조회로 갱신된다. 끊긴 사이의 선물 체결 보충 조회는 v0.3 범위가 아니다.
 */
export class FuturesAccountFeed {
  private readonly clock: Clock;
  private readonly timing: FuturesAccountTiming;
  private readonly endpoints: FuturesAccountEndpoints;
  private readonly hosts: readonly string[];
  private state: ConnState = 'idle';
  private attempt = 0;
  private stopped = false;
  private everReady = false;
  private connectSeq = 0;
  private session?: Session;
  private outageStart?: number;
  private seenTrades = new Set<string>();
  private timers: Partial<Record<TimerName, ReturnType<typeof setTimeout>>> = {};

  constructor(private o: FuturesAccountFeedOptions) {
    this.clock = o.clock ?? systemClock;
    this.timing = { pollMs: POLL_MS, keepaliveMs: KEEPALIVE_MS, ...o.timing };
    const mode = o.mode ?? 'mainnet';
    this.endpoints = o.endpoints ?? FUTURES_ACCOUNT_ENDPOINTS[mode];
    this.hosts = o.allowedHosts ?? hostsFor(mode);
  }

  get status(): { stream: string; state: ConnState; attempt: number } {
    return { stream: FUTURES_ACCOUNT_STREAM, state: this.state, attempt: this.attempt };
  }

  start(): void {
    if (this.state !== 'idle' && this.state !== 'closed') return;
    this.stopped = false;
    this.attempt = 0;
    this.outageStart = undefined;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.connectSeq++;
    for (const k of Object.keys(this.timers) as TimerName[]) this.clear(k);
    this.retire(this.session);
    this.session = undefined;
    this.setState('closed');
  }

  /** 절전 복귀 등: 끊김으로 세지 않고 즉시 다시 연결한다. 연결이 열리면 포지션을 다시 읽는다. */
  reconnectNow(): void {
    if (this.stopped || this.state === 'idle' || this.state === 'closed') return;
    for (const k of ['retry', 'rotate', 'keepalive', 'poll', 'refresh', 'outageWarn'] as const) this.clear(k);
    this.retire(this.session);
    this.session = undefined;
    this.attempt = 0;
    this.outageStart = undefined;
    void this.connect();
  }

  /** 규칙이 바뀌어 감시할 심볼이 달라졌을 때: 연결이 열려 있으면 포지션을 바로 다시 읽는다 */
  refreshNow(): void {
    const s = this.session;
    if (s && !s.dead && this.state === 'open') void this.refresh(s);
  }

  // ---- 연결 ----

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const seq = ++this.connectSeq;
    this.setState('connecting');

    let auth: AuthorizeResult;
    try {
      auth = await this.o.authorize();
    } catch (e) {
      auth = { ok: false, retry: true, detail: e instanceof Error ? e.name : 'authorize failed' };
    }
    if (this.stopped || seq !== this.connectSeq) return;
    if (!auth.ok) {
      if (auth.retry) return this.lost(`authorize: ${auth.detail}`);
      return this.fatal(auth.detail);
    }

    const issued = await listenKeyRequest('POST', auth.credentials.apiKey, this.rest());
    if (this.stopped || seq !== this.connectSeq) return;
    if (!issued.ok) {
      if (issued.reason === 'rejected') return this.fatal('listenKey request rejected (the API key may be invalid or this IP is not allowed)');
      return this.lost(`listenKey: ${issued.reason}`);
    }

    let socket: WebSocketLike;
    try {
      const url = `${this.endpoints.wsPrivate}?listenKey=${encodeURIComponent(issued.listenKey!)}&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE`;
      if (!isAllowedUrl(url, this.hosts)) throw new Error('blocked connection to a non-Binance host');
      socket = this.o.wsFactory ? this.o.wsFactory(url) : (new WebSocket(url) as unknown as WebSocketLike);
    } catch (e) {
      this.o.logger?.error(LOG, `cannot open socket: ${e instanceof Error ? e.message.replace(/listenKey=[^&\s]*/g, 'listenKey=***') : 'error'}`);
      return this.lost('open failed');
    }
    const session: Session = { socket, creds: auth.credentials, dead: false };
    this.session = session;
    socket.onopen = () => {
      if (!session.dead) this.onReady(session);
    };
    socket.onmessage = (ev) => {
      if (!session.dead) this.onMessage(session, ev.data);
    };
    const onEnd = () => {
      if (session.dead) return;
      this.retire(session);
      if (session === this.session) this.lost('connection closed');
    };
    socket.onclose = onEnd;
    socket.onerror = onEnd;
  }

  private onReady(session: Session): void {
    const reconnect = this.everReady;
    this.everReady = true;
    const outageStart = this.outageStart;
    this.outageStart = undefined;
    this.clear('outageWarn');
    this.attempt = 0;
    this.setState('open');
    if (reconnect && outageStart !== undefined) {
      const now = this.clock.now();
      this.emit({ type: 'conn.gap', ts: iso(now), from: iso(outageStart), to: iso(now), reason: 'disconnect' });
    }
    this.timers.rotate = setTimeout(() => this.rotate(), ROTATE_AFTER_MS);
    this.armKeepalive(session);
    void this.refresh(session).then(() => this.armPoll(session));
  }

  /** 24시간 만료 전에 미리 다시 연결한다 (끊김으로 세지 않음) */
  private rotate(): void {
    if (this.stopped) return;
    this.o.logger?.info(LOG, 'reconnecting before the 24-hour connection limit');
    this.reconnectNow();
  }

  // ---- 끊김 ----

  private lost(reason: string): void {
    if (this.stopped) return;
    this.o.logger?.info(LOG, `lost: ${reason}`);
    for (const k of ['rotate', 'keepalive', 'poll', 'refresh'] as const) this.clear(k);
    this.retire(this.session);
    this.session = undefined;
    if (this.outageStart === undefined) {
      this.outageStart = this.clock.now();
      this.timers.outageWarn = setTimeout(() => this.warnOutage(), OUTAGE_WARN_MS);
    }
    this.attempt++;
    this.setState('retrying');
    this.timers.retry = setTimeout(() => void this.connect(), retryDelayMs(this.attempt));
  }

  private warnOutage(): void {
    if (this.stopped || this.outageStart === undefined) return;
    const now = this.clock.now();
    this.emit({ type: 'conn.gap', ts: iso(now), from: iso(this.outageStart), to: iso(now), reason: 'disconnect', ongoing: true });
  }

  private fatal(detail: string): void {
    this.o.logger?.error(LOG, `futures account feed stopped: ${detail}`);
    this.stop();
    this.o.onFatal?.(detail);
  }

  // ---- listenKey 유지 ----

  private armKeepalive(session: Session): void {
    this.clear('keepalive');
    this.timers.keepalive = setTimeout(async () => {
      if (session.dead || this.stopped) return;
      const r = await listenKeyRequest('PUT', session.creds.apiKey, this.rest());
      if (session.dead || this.stopped) return;
      if (r.ok) return this.armKeepalive(session);
      if (r.reason === 'rejected') return this.fatal('listenKey keepalive rejected');
      this.o.logger?.warn(LOG, `listenKey keepalive failed (${r.reason})`);
      this.retire(session);
      this.lost('keepalive failed'); // 만료됐거나 연결이 불안하다: 새 listenKey로 다시 연결한다
    }, this.timing.keepaliveMs);
  }

  // ---- 이벤트 ----

  private onMessage(session: Session, raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    switch (msg.e) {
      case 'ORDER_TRADE_UPDATE': {
        const o = msg.o as Record<string, unknown> | undefined;
        if (!o || o.x !== 'TRADE') return; // x(실행 유형)가 TRADE일 때만 체결이다. 접수·취소·만료는 알리지 않는다.
        const qty = num(o.l);
        const price = num(o.L);
        const orderId = num(o.i);
        const tradeId = num(o.t);
        if (typeof o.s !== 'string' || ![qty, price, orderId, tradeId].every(Number.isFinite) || tradeId < 0) return;
        const key = `${o.s}:${tradeId}`;
        if (this.seenTrades.has(key)) return;
        this.seenTrades.add(key);
        if (this.seenTrades.size > SEEN_TRADES_MAX) this.seenTrades.delete(this.seenTrades.values().next().value as string);
        this.emit({ type: 'account.fill', ts: iso(this.clock.now()), market: 'futures', symbol: o.s, side: o.S === 'SELL' ? 'SELL' : 'BUY', qty, price, orderId, tradeId });
        this.scheduleRefresh(session); // 체결로 포지션이 바뀌었으니 청산가도 다시 읽는다
        return;
      }
      case 'ACCOUNT_UPDATE':
        this.scheduleRefresh(session);
        return;
      case 'listenKeyExpired':
        this.retire(session);
        if (session === this.session) this.lost('listenKey expired');
        return;
      default:
        return;
    }
  }

  // ---- 포지션 조회 (D-46) ----

  private rest(): AccountRestOptions {
    return { base: this.endpoints.rest, allowedHosts: this.hosts, fetchFn: this.o.fetchFn, sleep: this.o.sleep, now: () => this.clock.now(), logger: this.o.logger };
  }

  private scheduleRefresh(session: Session): void {
    if (this.timers.refresh) return;
    this.timers.refresh = setTimeout(() => {
      this.clear('refresh');
      if (!session.dead) void this.refresh(session);
    }, REFRESH_DEBOUNCE_MS);
  }

  private armPoll(session: Session): void {
    if (session.dead || this.stopped) return;
    this.clear('poll');
    this.timers.poll = setTimeout(async () => {
      if (session.dead || this.stopped) return;
      await this.refresh(session);
      this.armPoll(session);
    }, this.timing.pollMs);
  }

  /** 청산가 근접 규칙이 있는 심볼의 포지션을 읽어 방향별로 내보낸다. 포지션이 없는 방향은 크기 0으로 내보내 이전 값을 지운다. */
  private async refresh(session: Session): Promise<void> {
    const symbols = this.o.wants().liqSymbols;
    if (symbols.length === 0) return;
    const r = await fetchPositions(session.creds, this.rest());
    if (session.dead || this.stopped) return;
    if (!r.ok) {
      if (r.reason === 'rejected') return this.fatal('positionRisk rejected');
      this.o.logger?.warn(LOG, `position refresh failed (${r.reason})`);
      return;
    }
    const ts = iso(this.clock.now());
    for (const symbol of symbols) {
      const mine = r.positions.filter((p) => p.symbol === symbol);
      const mark = mine.find((p) => p.markPrice > 0)?.markPrice ?? 0;
      for (const side of ['LONG', 'SHORT'] as const) {
        const p: Position | undefined = mine.find((x) => x.side === side && x.size > 0);
        this.emit({ type: 'account.position', ts, symbol, side, size: p?.size ?? 0, entryPrice: p?.entryPrice ?? 0, liqPrice: p?.liqPrice ?? 0, markPrice: p?.markPrice ?? mark });
      }
    }
  }

  // ---- 공통 ----

  private emit(e: BlertEvent): void {
    this.o.bus.emit(e);
  }

  private retire(session: Session | undefined): void {
    if (!session) return;
    session.dead = true;
    try {
      session.socket.close(1000);
    } catch {
      // 이미 닫힌 소켓
    }
  }

  private setState(state: Exclude<ConnState, 'idle'>): void {
    this.state = state;
    this.emit({ type: 'conn.status', ts: iso(this.clock.now()), stream: FUTURES_ACCOUNT_STREAM, state, attempt: this.attempt });
  }

  private clear(k: TimerName): void {
    clearTimeout(this.timers[k]);
    delete this.timers[k];
  }
}
