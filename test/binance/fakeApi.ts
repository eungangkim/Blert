import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { vi } from 'vitest';
import type { WebSocketLike } from '../../src/binance/connection.js';

export interface ApiRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** 바이낸스 WebSocket API 연결을 흉내 내는 가짜 소켓 */
export class ApiSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly requests: ApiRequest[] = [];
  opened = false;
  closed = false;
  loggedIn = false;
  subscribed = false;

  constructor(
    readonly url: string,
    private server: FakeApiServer,
  ) {}

  send(data: string): void {
    if (!this.opened || this.closed) throw new Error('socket is not open');
    const req = JSON.parse(data) as ApiRequest;
    this.requests.push(req);
    this.server.handle(this, req);
  }
  close(): void {
    this.closed = true;
  }
  serverOpen(): void {
    this.opened = true;
    this.onopen?.({});
  }
  serverSend(obj: unknown): void {
    if (!this.closed) this.onmessage?.({ data: JSON.stringify(obj) });
  }
  serverDrop(): void {
    this.closed = true;
    this.onclose?.({});
  }
}

/**
 * 문서(authentication-requests, request-security)대로 동작하는 가짜 서버:
 * session.logon의 서명을 공개키로 검증하고, 로그인한 연결에만 userDataStream.subscribe를 허용한다.
 */
export class FakeApiServer {
  sockets: ApiSocket[] = [];
  refuse: boolean | ((url: string) => boolean) = false;
  /** 로그인 응답. 'ok'가 아니면 해당 상태·코드로 거부한다 */
  logonResult: 'ok' | { status: number; code: number } = 'ok';
  subscribeStatus = 200;
  /** false면 session.status에 응답하지 않는다 (반쯤 끊긴 연결) */
  respondStatus = true;
  readonly logons: { apiKey: unknown; timestamp: unknown; signature: unknown; keys: string[]; valid: boolean }[] = [];
  private publicKey: KeyObject;

  constructor(
    publicKey: KeyObject | string,
    readonly apiKey: string,
  ) {
    this.publicKey = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  }

  factory = (url: string): ApiSocket => {
    const s = new ApiSocket(url, this);
    this.sockets.push(s);
    const refused = typeof this.refuse === 'function' ? this.refuse(url) : this.refuse;
    queueMicrotask(() => (refused ? s.serverDrop() : s.serverOpen()));
    return s;
  };

  get live(): ApiSocket[] {
    return this.sockets.filter((s) => s.opened && !s.closed);
  }

  handle(socket: ApiSocket, req: ApiRequest): void {
    const reply = (status: number, result?: unknown, error?: { code: number; msg: string }) =>
      queueMicrotask(() => socket.serverSend({ id: req.id, status, ...(error ? { error } : { result: result ?? {} }) }));

    if (req.method === 'session.logon') {
      const p = req.params ?? {};
      // 서명 대상: signature를 뺀 params를 이름순으로 key=value&... (request-security 문서)
      const payload = Object.keys(p)
        .filter((k) => k !== 'signature')
        .sort()
        .map((k) => `${k}=${String(p[k])}`)
        .join('&');
      const valid =
        typeof p.signature === 'string' && p.apiKey === this.apiKey && verify(null, Buffer.from(payload, 'utf8'), this.publicKey, Buffer.from(p.signature, 'base64'));
      this.logons.push({ apiKey: p.apiKey, timestamp: p.timestamp, signature: p.signature, keys: Object.keys(p).sort(), valid });
      if (this.logonResult !== 'ok') return reply(this.logonResult.status, undefined, { code: this.logonResult.code, msg: 'rejected' });
      if (!valid) return reply(400, undefined, { code: -1022, msg: 'Signature for this request is not valid.' });
      socket.loggedIn = true;
      return reply(200, { apiKey: this.apiKey, authorizedSince: Date.now() });
    }
    if (req.method === 'userDataStream.subscribe') {
      if (!socket.loggedIn) return reply(401, undefined, { code: -2015, msg: 'not authenticated' });
      if (this.subscribeStatus !== 200) return reply(this.subscribeStatus, undefined, { code: -1003, msg: 'busy' });
      socket.subscribed = true;
      return reply(200, { subscriptionId: 0 });
    }
    if (req.method === 'session.status') {
      if (this.respondStatus) reply(200, { apiKey: socket.loggedIn ? this.apiKey : null, userDataStream: socket.subscribed });
      return;
    }
    reply(400, undefined, { code: -1116, msg: 'Invalid request' });
  }

  /** 구독한 연결로 사용자 데이터 이벤트를 보낸다 ({subscriptionId, event} 형태, general-api-information 문서) */
  event(ev: Record<string, unknown>): void {
    for (const s of this.live) if (s.subscribed) s.serverSend({ subscriptionId: 0, event: ev });
  }
  dropAll(): void {
    for (const s of this.live) s.serverDrop();
  }
}

// ---- 사용자 데이터 이벤트 페이로드 (필드명은 user-data-stream 문서) ----
export const executionReport = (o: { symbol: string; side: 'BUY' | 'SELL'; qty: number | string; price: number | string; orderId: number; tradeId: number; type?: string }) => ({
  e: 'executionReport', E: Date.now(), s: o.symbol, c: 'abc', S: o.side, o: 'LIMIT', f: 'GTC', q: String(o.qty), p: String(o.price),
  x: o.type ?? 'TRADE', X: o.type === 'TRADE' || !o.type ? 'FILLED' : o.type, i: o.orderId, l: String(o.qty), z: String(o.qty), L: String(o.price), t: o.tradeId, T: Date.now(),
});
export const accountPosition = (balances: { asset: string; free: number; locked?: number }[]) => ({
  e: 'outboundAccountPosition', E: Date.now(), u: Date.now(), B: balances.map((b) => ({ a: b.asset, f: String(b.free), l: String(b.locked ?? 0) })),
});

// ---- 가짜 REST (계정 조회) ----
export interface FakeTrade {
  symbol: string;
  id: number;
  orderId: number;
  price: number;
  qty: number;
  time: number;
  isBuyer: boolean;
}

/** GET /api/v3/account, /api/v3/myTrades. 모든 요청의 서명을 공개키로 검증한다. */
export class FakeAccountRest {
  balances: { asset: string; free: number; locked: number }[] = [];
  trades: FakeTrade[] = [];
  invalidSymbols = new Set<string>();
  readonly calls: { origin: string; path: string; params: Record<string, string>; headers: Record<string, string> }[] = [];
  invalidSignatures = 0;
  /** 앞쪽부터 한 번씩 먼저 돌려줄 특수 응답 (요청 한도 등) */
  queue: Response[] = [];
  private publicKey: KeyObject;

  constructor(
    publicKey: KeyObject | string,
    readonly apiKey: string,
  ) {
    this.publicKey = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  }

  fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const u = new URL(url);
    const idx = url.indexOf('&signature=');
    const signed = url.slice(url.indexOf('?') + 1, idx);
    const signature = decodeURIComponent(url.slice(idx + '&signature='.length));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const params = Object.fromEntries(u.searchParams);
    delete params.signature;
    this.calls.push({ origin: u.origin, path: u.pathname, params, headers });
    // signature는 쿼리의 마지막이어야 하고, 서명은 그 앞부분 전체에 대한 것이다
    if (idx < 0 || !verify(null, Buffer.from(signed, 'utf8'), this.publicKey, Buffer.from(signature, 'base64')) || headers['X-MBX-APIKEY'] !== this.apiKey) {
      this.invalidSignatures++;
      return new Response(JSON.stringify({ code: -1022, msg: 'Signature for this request is not valid.' }), { status: 400 });
    }
    const special = this.queue.shift();
    if (special) return special;

    if (u.pathname === '/api/v3/account') {
      return new Response(JSON.stringify({ balances: this.balances.map((b) => ({ asset: b.asset, free: String(b.free), locked: String(b.locked) })), updateTime: Date.now() }), { status: 200 });
    }
    if (u.pathname === '/api/v3/myTrades') {
      const symbol = params.symbol!;
      if (this.invalidSymbols.has(symbol)) return new Response(JSON.stringify({ code: -1121, msg: 'Invalid symbol.' }), { status: 400 });
      const start = Number(params.startTime ?? 0);
      const limit = Number(params.limit ?? 500);
      const rows = this.trades
        .filter((t) => t.symbol === symbol && t.time >= start)
        .sort((a, b) => a.time - b.time || a.id - b.id)
        .slice(0, limit)
        .map((t) => ({ symbol, id: t.id, orderId: t.orderId, price: String(t.price), qty: String(t.qty), quoteQty: String(t.price * t.qty), commission: '0', commissionAsset: 'BNB', time: t.time, isBuyer: t.isBuyer, isMaker: false }));
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });

  get fetchFn(): typeof fetch {
    return this.fetch as unknown as typeof fetch;
  }

  tradeCalls(): { symbol: string; startTime: number }[] {
    return this.calls.filter((c) => c.path === '/api/v3/myTrades').map((c) => ({ symbol: c.params.symbol!, startTime: Number(c.params.startTime) }));
  }
  accountCalls(): number {
    return this.calls.filter((c) => c.path === '/api/v3/account').length;
  }
}
