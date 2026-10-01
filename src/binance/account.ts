import type { EventBus } from '../shared/bus.js';
import type { BlertEvent } from '../shared/events.js';
import { iso, systemClock, type Clock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import { allowedHosts as hostsFor, isAllowedUrl, type NetworkMode } from '../shared/network.js';
import { STABLE_QUOTES } from '../shared/symbol.js';
import type { Credentials } from '../security/index.js';
import { ACCOUNT_ENDPOINTS, type AccountEndpoints } from './endpoints.js';
import { OUTAGE_WARN_MS, ROTATE_AFTER_MS, retryDelayMs, type ConnState, type WebSocketLike, type WsFactory } from './connection.js';
import { fetchBalances, fetchTrades, type AccountRestOptions, type Trade } from './account-rest.js';

const LOG = 'binance.account';
export const ACCOUNT_STREAM = 'account';
const SEEN_TRADES_MAX = 5000;
/** 보충 조회는 끊기기 직전 생존 시각보다 이만큼 앞에서 시작한다 (경계의 체결을 놓치지 않으려는 여유, 중복은 체결 ID로 제거) */
const BACKFILL_MARGIN_MS = 60_000;

/** 연결(재연결)을 시도하기 전에 키를 쓸 수 있는지 확인한 결과 (FR-KEY-04) */
export type AuthorizeResult =
  | { ok: true; credentials: Credentials }
  /** 쓸 수 없다. retry가 true면 일시적인 문제(네트워크 등)라 백오프로 다시 확인하고, false면 이 연결을 멈춘다. */
  | { ok: false; retry: boolean; detail: string };

/** 현재 규칙이 계정 연결에 요구하는 것 */
export interface AccountWants {
  balances: boolean;
  fills: boolean;
  /** 심볼 지정 없는 체결 규칙(*)이 있는가 */
  allFills: boolean;
  /** 심볼을 지정한 체결 규칙의 심볼 */
  fillSymbols: string[];
}

export interface AccountTiming {
  /** session.status 확인 간격과 응답 대기 시간. 사용자 스트림은 거래가 없으면 조용해서 반쯤 끊긴 연결을 이것으로 알아챈다. */
  heartbeatMs: number;
  heartbeatTimeoutMs: number;
  requestTimeoutMs: number;
}

export const DEFAULT_ACCOUNT_TIMING: AccountTiming = { heartbeatMs: 60_000, heartbeatTimeoutMs: 15_000, requestTimeoutMs: 10_000 };

export interface AccountFeedOptions {
  bus: EventBus;
  authorize: () => Promise<AuthorizeResult>;
  wants: () => AccountWants;
  /** 이 연결을 더는 쓸 수 없을 때(키 거부 등) 한 번 부른다. 재시도하지 않는다. */
  onFatal?: (detail: string) => void;
  clock?: Clock;
  logger?: Logger;
  mode?: NetworkMode;
  endpoints?: AccountEndpoints;
  allowedHosts?: readonly string[];
  wsFactory?: WsFactory;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timing?: Partial<AccountTiming>;
}

interface ApiResponse {
  id?: unknown;
  status?: number;
  result?: unknown;
  error?: { code?: number; msg?: string };
}

interface Session {
  socket: WebSocketLike;
  creds: Credentials;
  dead: boolean;
  pending: Map<string, { resolve: (r: ApiResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
}

type TimerName = 'retry' | 'rotate' | 'heartbeat' | 'outageWarn';

/**
 * 바이낸스 사용자 데이터 스트림 (현물 체결·잔고, v0.2). listenKey 없이 WebSocket API로
 * session.logon(Ed25519) → userDataStream.subscribe 한다 (D-06). 문서 링크는 endpoints.ts.
 * - 연결을 시도할 때마다 authorize()로 키 권한을 다시 확인한다. 권한 위반이면 이 연결만 멈춘다 (FR-KEY-04).
 * - 끊기면 공개 스트림과 같은 백오프로 재연결하고, 복구되면 잔고 스냅샷과 끊긴 사이의 체결을 보충 조회한다 (FR-CONN-02).
 * - 24시간 연결 만료 10분 전에 미리 다시 연결한다. 그 짧은 틈도 보충 조회가 메운다.
 */
export class AccountFeed {
  private readonly clock: Clock;
  private readonly timing: AccountTiming;
  private readonly endpoints: AccountEndpoints;
  private readonly hosts: readonly string[];
  private state: Exclude<ConnState, 'idle'> | 'idle' = 'idle';
  private attempt = 0;
  private stopped = false;
  private everReady = false;
  private connectSeq = 0;
  private reqSeq = 0;
  private session?: Session;
  private outageStart?: number;
  /** 마지막으로 연결이 살아 있었다고 확인한 시각 (메시지·상태 응답) */
  private lastAliveAt = 0;
  /** 보충 조회를 시작할 시각: 끊기기 직전의 생존 시각 */
  private resumeFrom?: number;
  private holdings: string[] = [];
  private seenTrades = new Set<string>();
  private seenFillSymbols = new Set<string>();
  private timers: Partial<Record<TimerName, ReturnType<typeof setTimeout>>> = {};

  constructor(private o: AccountFeedOptions) {
    this.clock = o.clock ?? systemClock;
    this.timing = { ...DEFAULT_ACCOUNT_TIMING, ...o.timing };
    const mode = o.mode ?? 'mainnet';
    this.endpoints = o.endpoints ?? ACCOUNT_ENDPOINTS[mode];
    this.hosts = o.allowedHosts ?? hostsFor(mode);
  }

  get status(): { stream: string; state: ConnState; attempt: number } {
    return { stream: ACCOUNT_STREAM, state: this.state, attempt: this.attempt };
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

  /** 절전 복귀 등: 끊김으로 세지 않고 즉시 다시 연결한다. 끊긴 사이는 보충 조회가 메운다. */
  reconnectNow(): void {
    if (this.stopped || this.state === 'idle' || this.state === 'closed') return;
    this.resumeFrom = this.resumeFrom ?? this.lastAliveAt;
    this.clear('retry');
    this.clear('rotate');
    this.clear('heartbeat');
    this.retire(this.session);
    this.session = undefined;
    this.attempt = 0;
    this.outageStart = undefined;
    this.clear('outageWarn');
    void this.connect();
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

    let socket: WebSocketLike;
    try {
      if (!isAllowedUrl(this.endpoints.wsApi, this.hosts)) throw new Error('blocked connection to a non-Binance host');
      socket = this.o.wsFactory ? this.o.wsFactory(this.endpoints.wsApi) : (new WebSocket(this.endpoints.wsApi) as unknown as WebSocketLike);
    } catch (e) {
      this.o.logger?.error(LOG, `cannot open socket: ${e instanceof Error ? e.message : String(e)}`);
      return this.lost('open failed');
    }
    const session: Session = { socket, creds: auth.credentials, dead: false, pending: new Map() };
    this.session = session;
    socket.onopen = () => {
      if (!session.dead) void this.handshake(session);
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

  /** session.logon → userDataStream.subscribe. 문서: authentication-requests, user-data-stream-requests */
  private async handshake(session: Session): Promise<void> {
    try {
      const timestamp = this.clock.now();
      // 서명 대상: apiKey를 포함한 params(signature 제외)를 이름순으로 key=value&... (request-security 문서)
      const signature = session.creds.sign(`apiKey=${session.creds.apiKey}&timestamp=${timestamp}`);
      const logon = await this.request(session, 'session.logon', { apiKey: session.creds.apiKey, timestamp, signature });
      if (session.dead) return;
      if (logon.status !== 200) return this.logonFailed(session, logon);

      const sub = await this.request(session, 'userDataStream.subscribe');
      if (session.dead) return;
      if (sub.status !== 200) {
        this.o.logger?.warn(LOG, `subscribe failed: status ${sub.status ?? '?'} code ${sub.error?.code ?? '?'}`);
        this.retire(session);
        return this.lost('subscribe failed');
      }
      this.onReady(session);
    } catch (e) {
      if (session.dead) return;
      this.o.logger?.warn(LOG, `handshake failed: ${e instanceof Error ? e.message : 'error'}`);
      this.retire(session);
      this.lost('handshake failed');
    }
  }

  private logonFailed(session: Session, res: ApiResponse): void {
    const code = res.error?.code;
    const detail = `logon rejected (status ${res.status ?? '?'}${code !== undefined ? ` code ${code}` : ''}${res.error?.msg ? `: ${res.error.msg}` : ''})`;
    this.retire(session);
    // 키·서명·허용 IP 문제는 다시 시도해도 같다. 그 밖(점검, 요청 한도 등)은 일시적일 수 있다.
    if (res.status === 401 || res.status === 403 || code === -2014 || code === -2015 || code === -1022) return this.fatal(detail);
    this.o.logger?.warn(LOG, detail);
    this.lost('logon failed');
  }

  private onReady(session: Session): void {
    const reconnect = this.everReady;
    this.everReady = true;
    const outageStart = this.outageStart;
    this.outageStart = undefined;
    this.clear('outageWarn');
    this.attempt = 0;
    this.lastAliveAt = this.clock.now();
    this.setState('open');
    if (reconnect && outageStart !== undefined) {
      const now = this.clock.now();
      this.emit({ type: 'conn.gap', ts: iso(now), from: iso(outageStart), to: iso(now), reason: 'disconnect' });
    }
    this.timers.rotate = setTimeout(() => this.rotate(), ROTATE_AFTER_MS);
    this.armHeartbeat(session);
    void this.sync(session, reconnect);
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
    this.clear('rotate');
    this.clear('heartbeat');
    this.retire(this.session);
    this.session = undefined;
    if (this.outageStart === undefined) {
      this.outageStart = this.clock.now();
      this.resumeFrom = this.lastAliveAt;
      const wait = Math.max(0, this.outageStart + OUTAGE_WARN_MS - this.clock.now());
      this.timers.outageWarn = setTimeout(() => this.warnOutage(), wait);
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
    this.o.logger?.error(LOG, `account feed stopped: ${detail}`);
    this.stop();
    this.o.onFatal?.(detail);
  }

  private armHeartbeat(session: Session): void {
    this.clear('heartbeat');
    this.timers.heartbeat = setTimeout(async () => {
      if (session.dead || this.stopped) return;
      try {
        const res = await this.request(session, 'session.status', undefined, this.timing.heartbeatTimeoutMs);
        if (session.dead) return;
        if (res.status !== 200) throw new Error(`status ${res.status ?? '?'}`);
        this.lastAliveAt = this.clock.now();
        this.armHeartbeat(session);
      } catch (e) {
        if (session.dead) return;
        this.o.logger?.warn(LOG, `heartbeat failed: ${e instanceof Error ? e.message : 'error'}`);
        this.retire(session);
        this.lost('heartbeat');
      }
    }, this.timing.heartbeatMs);
  }

  // ---- 요청·응답, 이벤트 ----

  private request(session: Session, method: string, params?: Record<string, unknown>, timeoutMs = this.timing.requestTimeoutMs): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      const id = `r${++this.reqSeq}`;
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      session.pending.set(id, { resolve, reject, timer });
      try {
        session.socket.send(JSON.stringify(params ? { id, method, params } : { id, method }));
      } catch (e) {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(e instanceof Error ? e : new Error('send failed'));
      }
    });
  }

  private onMessage(session: Session, raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    this.lastAliveAt = this.clock.now();
    if (msg.id !== undefined) {
      const p = session.pending.get(String(msg.id));
      if (p) {
        clearTimeout(p.timer);
        session.pending.delete(String(msg.id));
        p.resolve(msg as ApiResponse);
      }
      return;
    }
    const event = msg.event as Record<string, unknown> | undefined;
    if (event && typeof event === 'object') this.onEvent(session, event);
  }

  private onEvent(session: Session, ev: Record<string, unknown>): void {
    switch (ev.e) {
      case 'executionReport': {
        // x(현재 실행 유형)가 TRADE일 때만 체결이다. 접수·취소·만료는 알리지 않는다.
        if (ev.x !== 'TRADE') return;
        const trade: Trade = {
          symbol: String(ev.s),
          side: ev.S === 'SELL' ? 'SELL' : 'BUY',
          qty: Number(ev.l),
          price: Number(ev.L),
          orderId: Number(ev.i),
          tradeId: Number(ev.t),
          time: Number(ev.T),
        };
        if (![trade.qty, trade.price, trade.orderId, trade.tradeId].every(Number.isFinite) || trade.tradeId < 0) return;
        this.emitFill(trade);
        return;
      }
      case 'outboundAccountPosition': {
        for (const b of (Array.isArray(ev.B) ? ev.B : []) as { a?: unknown; f?: unknown; l?: unknown }[]) {
          const free = Number(b.f);
          const locked = Number(b.l);
          if (typeof b.a === 'string' && Number.isFinite(free) && Number.isFinite(locked)) {
            this.emit({ type: 'account.balance', ts: iso(this.clock.now()), asset: b.a, free, locked });
          }
        }
        return;
      }
      case 'eventStreamTerminated':
        this.retire(session);
        if (session === this.session) this.lost('event stream terminated');
        return;
      default:
        return; // balanceUpdate 등은 outboundAccountPosition으로 충분하다
    }
  }

  private emitFill(t: Trade): void {
    const key = `${t.symbol}:${t.tradeId}`;
    if (this.seenTrades.has(key)) return; // 실시간으로 받은 체결이 보충 조회에 또 나와도 한 번만 알린다
    this.seenTrades.add(key);
    if (this.seenTrades.size > SEEN_TRADES_MAX) this.seenTrades.delete(this.seenTrades.values().next().value as string);
    this.seenFillSymbols.add(t.symbol);
    this.emit({ type: 'account.fill', ts: iso(this.clock.now()), market: 'spot', symbol: t.symbol, side: t.side, qty: t.qty, price: t.price, orderId: t.orderId, tradeId: t.tradeId });
  }

  // ---- 기준 잡기·보충 조회 (FR-CONN-02) ----

  private rest(): AccountRestOptions {
    return { base: this.endpoints.rest, allowedHosts: this.hosts, fetchFn: this.o.fetchFn, sleep: this.o.sleep, now: () => this.clock.now(), logger: this.o.logger };
  }

  /**
   * 연결이 열린 직후: 잔고 스냅샷으로 기준을 (다시) 잡고, 다시 연결한 경우에는 끊긴 사이의 체결을 보충 조회한다.
   * 잔고는 스냅샷 값을 account.balance로 내보내므로, 끊긴 사이 크게 바뀌었다면 규칙이 그대로 알린다.
   */
  private async sync(session: Session, reconnect: boolean): Promise<void> {
    const wants = this.o.wants();
    const from = (this.resumeFrom ?? this.lastAliveAt) - BACKFILL_MARGIN_MS;
    this.resumeFrom = undefined;
    try {
      if (wants.balances || (reconnect && wants.fills && wants.allFills)) {
        const r = await fetchBalances(session.creds, this.rest());
        if (session.dead) return;
        if (r.ok) {
          this.holdings = r.balances.filter((b) => b.free + b.locked > 0).map((b) => b.asset);
          if (wants.balances) for (const b of r.balances) this.emit({ type: 'account.balance', ts: iso(this.clock.now()), asset: b.asset, free: b.free, locked: b.locked });
        } else {
          this.o.logger?.warn(LOG, `balance snapshot failed (${r.reason})`);
        }
      }
      if (reconnect && wants.fills) await this.backfillFills(session, wants, from);
    } catch (e) {
      this.o.logger?.error(LOG, `sync failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 조회할 심볼(결정 2A): 규칙의 심볼 + (전체 규칙이면) 보유 자산의 USDT 쌍 + 이번 실행에서 체결이 있던 심볼 */
  private backfillSymbols(wants: AccountWants): string[] {
    const symbols = new Set(wants.fillSymbols);
    if (wants.allFills) {
      for (const asset of this.holdings) if (!STABLE_QUOTES.includes(asset)) symbols.add(`${asset}USDT`);
      for (const s of this.seenFillSymbols) symbols.add(s);
    }
    return [...symbols];
  }

  private async backfillFills(session: Session, wants: AccountWants, from: number): Promise<void> {
    let found = 0;
    for (const symbol of this.backfillSymbols(wants)) {
      if (session.dead) return;
      const r = await fetchTrades(symbol, from, session.creds, this.rest());
      if (!r.ok) {
        if (r.reason !== 'invalid-symbol') this.o.logger?.warn(LOG, `trade backfill failed for ${symbol} (${r.reason})`);
        continue;
      }
      for (const t of r.trades.sort((a, b) => a.time - b.time || a.tradeId - b.tradeId)) {
        const before = this.seenTrades.size;
        this.emitFill(t);
        if (this.seenTrades.size !== before) found++;
      }
    }
    this.o.logger?.info(LOG, `trade backfill done: ${found} missed trades`);
  }

  // ---- 공통 ----

  private emit(e: BlertEvent): void {
    this.o.bus.emit(e);
  }

  private retire(session: Session | undefined): void {
    if (!session) return;
    session.dead = true;
    for (const p of session.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('session closed'));
    }
    session.pending.clear();
    try {
      session.socket.close(1000);
    } catch {
      // 이미 닫힌 소켓
    }
  }

  private setState(state: Exclude<ConnState, 'idle'>): void {
    this.state = state;
    this.emit({ type: 'conn.status', ts: iso(this.clock.now()), stream: ACCOUNT_STREAM, state, attempt: this.attempt });
  }

  private clear(k: TimerName): void {
    clearTimeout(this.timers[k]);
    delete this.timers[k];
  }
}
