import type { BlertEvent } from '../shared/events.js';
import type { Clock } from '../shared/clock.js';
import { iso } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';

const LOG = 'binance.conn';
const SECOND = 1000;
const MINUTE = 60 * SECOND;

// NFR-REL-01, B5 연결 생명주기
export const RETRY_BASE_MS = 1 * SECOND;
export const RETRY_MAX_MS = 60 * SECOND;
/** attempt번째 실패 뒤 기다리는 시간: 1초, 2초, 4초 … 최대 60초 */
export const retryDelayMs = (attempt: number): number => Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
export const OUTAGE_WARN_MS = 5 * MINUTE;
/** 24시간 연결 만료 10분 전에 새 연결로 옮긴다 */
export const ROTATE_AFTER_MS = 24 * 60 * MINUTE - 10 * MINUTE;
const ROTATION_ACK_TIMEOUT_MS = 15 * SECOND;
const ROTATION_RETRY_MS = 1 * MINUTE;
/** 이 시간 동안 아무 메시지도 없으면 반쯤 끊긴 연결로 보고 다시 연결한다 */
export const WATCHDOG_IDLE_MS = 3 * MINUTE;
const WATCHDOG_TICK_MS = 30 * SECOND;
/** 구독 메시지는 수신 한도(현물 5/초, 선물 10/초)를 넘지 않게 나눠 보낸다 */
const SUB_CHUNK = 100;
const SUB_SPACING_MS = 250;

/** WHATWG WebSocket의 사용 부분집합. 테스트에서 가짜 소켓을 끼우기 위함. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsFactory = (url: string) => WebSocketLike;

export type ConnState = 'idle' | 'connecting' | 'open' | 'retrying' | 'closed';

interface Session {
  socket: WebSocketLike;
  opened: boolean;
  dead: boolean;
  subscribed: Set<string>;
  queue: string[];
  sending: boolean;
  lastSubId?: number;
}

export interface ConnectionDeps {
  /** conn.status의 stream 값 (예: spot, futures#2) */
  name: string;
  url: string;
  factory: WsFactory;
  clock: Clock;
  emit(event: BlertEvent): void;
  onData(stream: string, data: unknown): void;
  /** 처음이 아닌 (재)연결이 열렸을 때. 끊긴 사이 데이터 보충용. */
  onReconnected?(): void;
  logger?: Logger;
}

/**
 * 결합 스트림 연결 하나. /stream에 붙은 뒤 SUBSCRIBE로 구독한다.
 * - 끊기면 1초부터 최대 60초까지 지수 백오프로 무한 재시도 (NFR-REL-01)
 * - 5분 넘게 끊겨 있으면 ongoing: true인 conn.gap을 한 번 내보낸다 (아직 복구되지 않은 끊김 경고)
 * - 다시 열리면 끊긴 구간 전체를 conn.gap으로 내보낸다 (NFR-REL-02)
 * - 24시간 만료 10분 전에 새 연결을 열고 구독 확인 뒤에 옛 연결을 닫는다
 */
export class ManagedConnection {
  private desired = new Set<string>();
  private active?: Session;
  private pending?: Session;
  private state: ConnState = 'idle';
  private attempt = 0;
  private stopped = false;
  private everOpened = false;
  private outageStart?: number;
  private lastMessageAt = 0;
  private nextId = 1;
  private timers: Partial<Record<'retry' | 'rotate' | 'rotationRetry' | 'rotationAck' | 'outageWarn' | 'watchdog', ReturnType<typeof setTimeout>>> = {};

  constructor(private deps: ConnectionDeps) {}

  get status(): { stream: string; state: ConnState; attempt: number } {
    return { stream: this.deps.name, state: this.state, attempt: this.attempt };
  }

  get streamCount(): number {
    return this.desired.size;
  }

  start(): void {
    if (this.state !== 'idle' && this.state !== 'closed') return;
    this.stopped = false;
    this.attempt = 0;
    this.outageStart = undefined;
    this.connect();
  }

  setStreams(streams: Iterable<string>): void {
    this.desired = new Set(streams);
    if (this.active?.opened) this.reconcile(this.active);
    if (this.pending?.opened) this.reconcile(this.pending);
  }

  stop(): void {
    this.stopped = true;
    for (const k of Object.keys(this.timers) as (keyof typeof this.timers)[]) this.clear(k);
    this.retire(this.active);
    this.retire(this.pending);
    this.active = this.pending = undefined;
    this.setState('closed');
  }

  /** 절전 복귀 등으로 모든 연결을 즉시 새로 맺는다 (FR-RUN-02). 끊김 구간은 호출한 쪽이 알린다. */
  reconnectNow(): void {
    if (this.stopped || this.state === 'idle' || this.state === 'closed') return;
    this.clear('retry');
    this.clear('rotate');
    this.clear('watchdog');
    this.retire(this.pending);
    this.pending = undefined;
    this.retire(this.active);
    this.active = undefined;
    this.attempt = 0;
    this.outageStart = undefined;
    this.clear('outageWarn');
    this.connect();
  }

  // ---- 연결 ----

  private connect(): void {
    if (this.stopped) return;
    this.setState('connecting');
    try {
      this.active = this.open('active');
    } catch (e) {
      this.deps.logger?.error(LOG, `${this.deps.name}: cannot open socket: ${String(e)}`);
      this.lost(undefined);
    }
  }

  private open(role: 'active' | 'pending'): Session {
    const session: Session = { socket: this.deps.factory(this.deps.url), opened: false, dead: false, subscribed: new Set(), queue: [], sending: false };
    const socket = session.socket;
    socket.onopen = () => {
      if (session.dead) return;
      session.opened = true;
      if (role === 'active') this.onActiveOpen(session);
      else this.onPendingOpen(session);
    };
    socket.onmessage = (ev) => {
      if (session.dead) return;
      this.onMessage(session, ev.data);
    };
    const onEnd = () => {
      if (session.dead) return;
      session.dead = true;
      if (session === this.active) this.lost(undefined);
      else if (session === this.pending) this.rotationFailed();
    };
    socket.onclose = onEnd;
    socket.onerror = onEnd;
    return session;
  }

  private onActiveOpen(session: Session): void {
    const now = this.deps.clock.now();
    this.lastMessageAt = now;
    this.reconcile(session);
    const reconnect = this.everOpened;
    this.everOpened = true;
    const outageStart = this.outageStart;
    this.outageStart = undefined;
    this.clear('outageWarn');
    this.attempt = 0;
    this.setState('open');
    if (reconnect && outageStart !== undefined) {
      this.deps.emit({ type: 'conn.gap', ts: iso(now), from: iso(outageStart), to: iso(now), reason: 'disconnect' });
    }
    if (reconnect) this.deps.onReconnected?.();
    this.timers.rotate = setTimeout(() => this.startRotation(), ROTATE_AFTER_MS);
    this.armWatchdog();
  }

  /** 끊김 처리. idleSince가 있으면 무응답 감시가 잡은 것이라 그 시각부터를 끊긴 구간으로 본다. */
  private lost(idleSince: number | undefined): void {
    if (this.stopped) return;
    this.clear('rotate');
    this.clear('watchdog');
    this.retire(this.pending);
    this.pending = undefined;
    this.retire(this.active);
    this.active = undefined;

    if (this.outageStart === undefined) {
      this.outageStart = idleSince ?? this.deps.clock.now();
      const wait = Math.max(0, this.outageStart + OUTAGE_WARN_MS - this.deps.clock.now());
      this.timers.outageWarn = setTimeout(() => this.warnOutage(), wait);
    }
    this.attempt++;
    this.setState('retrying');
    this.timers.retry = setTimeout(() => this.connect(), retryDelayMs(this.attempt));
  }

  private warnOutage(): void {
    if (this.stopped || this.outageStart === undefined) return;
    const now = this.deps.clock.now();
    this.deps.emit({ type: 'conn.gap', ts: iso(now), from: iso(this.outageStart), to: iso(now), reason: 'disconnect', ongoing: true });
  }

  private armWatchdog(): void {
    this.clear('watchdog');
    this.timers.watchdog = setTimeout(() => {
      const idle = this.deps.clock.now() - this.lastMessageAt;
      if (this.desired.size > 0 && idle > WATCHDOG_IDLE_MS && this.active) {
        this.deps.logger?.warn(LOG, `${this.deps.name}: no messages for ${Math.round(idle / SECOND)}s, reconnecting`);
        const since = this.lastMessageAt;
        this.active.dead = true;
        this.lost(since);
      } else this.armWatchdog();
    }, WATCHDOG_TICK_MS);
  }

  // ---- 24시간 교체 ----

  private startRotation(): void {
    if (this.stopped || !this.active || this.pending) return;
    try {
      this.pending = this.open('pending');
    } catch (e) {
      this.deps.logger?.error(LOG, `${this.deps.name}: cannot open replacement socket: ${String(e)}`);
      this.timers.rotationRetry = setTimeout(() => this.startRotation(), ROTATION_RETRY_MS);
      return;
    }
    this.timers.rotationAck = setTimeout(() => {
      if (!this.pending) return;
      this.pending.dead = true;
      this.rotationFailed();
    }, ROTATION_ACK_TIMEOUT_MS);
  }

  private onPendingOpen(session: Session): void {
    this.reconcile(session);
    if (session.queue.length === 0 && session.lastSubId === undefined) this.promote(session); // 구독할 것이 없음
  }

  private promote(session: Session): void {
    this.clear('rotationAck');
    const old = this.active;
    this.active = session;
    this.pending = undefined;
    this.retire(old);
    this.lastMessageAt = this.deps.clock.now();
    this.reconcile(session); // 교체하는 동안 바뀐 구독 반영
    this.timers.rotate = setTimeout(() => this.startRotation(), ROTATE_AFTER_MS);
  }

  private rotationFailed(): void {
    this.clear('rotationAck');
    this.retire(this.pending);
    this.pending = undefined;
    if (this.stopped || !this.active) return;
    this.deps.logger?.warn(LOG, `${this.deps.name}: connection rotation failed, retrying`);
    this.timers.rotationRetry = setTimeout(() => this.startRotation(), ROTATION_RETRY_MS);
  }

  // ---- 메시지·구독 ----

  private onMessage(session: Session, raw: unknown): void {
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      this.deps.logger?.warn(LOG, `${this.deps.name}: non-JSON message ignored`);
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { stream?: unknown; data?: unknown; id?: unknown; code?: unknown; msg?: unknown };
    if (m.id !== undefined) {
      if (m.code !== undefined) this.deps.logger?.warn(LOG, `${this.deps.name}: request ${String(m.id)} rejected: code=${String(m.code)}`);
      if (session === this.pending && m.id === session.lastSubId) this.promote(session);
      return;
    }
    if (session === this.active && typeof m.stream === 'string') {
      this.lastMessageAt = this.deps.clock.now();
      this.deps.onData(m.stream, m.data);
    }
  }

  /** 세션의 구독 상태를 desired에 맞춘다. 메시지는 한도를 넘지 않게 간격을 두고 보낸다. */
  private reconcile(session: Session): void {
    const add = [...this.desired].filter((s) => !session.subscribed.has(s));
    const del = [...session.subscribed].filter((s) => !this.desired.has(s));
    const enqueue = (method: 'SUBSCRIBE' | 'UNSUBSCRIBE', streams: string[]) => {
      for (let i = 0; i < streams.length; i += SUB_CHUNK) {
        const id = this.nextId++;
        session.queue.push(JSON.stringify({ method, params: streams.slice(i, i + SUB_CHUNK), id }));
        session.lastSubId = id;
      }
    };
    enqueue('UNSUBSCRIBE', del);
    enqueue('SUBSCRIBE', add);
    for (const s of del) session.subscribed.delete(s);
    for (const s of add) session.subscribed.add(s);
    this.pump(session);
  }

  private pump(session: Session): void {
    if (session.sending || session.dead || session.queue.length === 0) return;
    const next = session.queue.shift()!;
    session.sending = true;
    try {
      session.socket.send(next);
    } catch (e) {
      this.deps.logger?.warn(LOG, `${this.deps.name}: send failed: ${String(e)}`);
    }
    setTimeout(() => {
      session.sending = false;
      this.pump(session);
    }, SUB_SPACING_MS);
  }

  // ---- 공통 ----

  private retire(session: Session | undefined): void {
    if (!session) return;
    session.dead = true;
    session.queue.length = 0;
    try {
      session.socket.close(1000);
    } catch {
      // 이미 닫힌 소켓
    }
  }

  private setState(state: Exclude<ConnState, 'idle'>): void {
    this.state = state;
    this.deps.emit({ type: 'conn.status', ts: iso(this.deps.clock.now()), stream: this.deps.name, state, attempt: this.attempt });
  }

  private clear(key: keyof typeof this.timers): void {
    clearTimeout(this.timers[key]);
    delete this.timers[key];
  }
}
