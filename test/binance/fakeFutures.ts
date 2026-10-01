import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { vi } from 'vitest';
import type { WebSocketLike } from '../../src/binance/connection.js';

/** 선물 사용자 데이터 WebSocket(listenKey 방식)을 흉내 내는 가짜 소켓 */
export class FutSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  opened = false;
  closed = false;

  constructor(readonly url: string) {}

  send(): void {
    throw new Error('the futures user data stream accepts no requests');
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

export interface FakePositionRow {
  symbol: string;
  positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  positionAmt: string;
  entryPrice?: string;
  markPrice: string;
  liquidationPrice: string;
}

/**
 * 선물 listenKey(POST/PUT/DELETE /fapi/v1/listenKey)와 포지션 조회(GET /fapi/v3/positionRisk)를 흉내 내는 가짜 서버.
 * listenKey 요청은 X-MBX-APIKEY 헤더만 확인하고(서명 없음), 포지션 조회는 서명을 공개키로 검증한다.
 */
export class FakeFuturesApi {
  sockets: FutSocket[] = [];
  refuseSockets = false;
  positions: FakePositionRow[] = [];
  /** true면 다음 PUT이 "listenKey 없음"(-1125)으로 거절된다 */
  expireNextKeepalive = false;
  /** 앞쪽부터 한 번씩 먼저 돌려줄 특수 응답 (키 거부 등) */
  queue: Response[] = [];
  invalidSignatures = 0;
  readonly calls: { method: string; origin: string; path: string; params: Record<string, string>; headers: Record<string, string>; hasSignature: boolean }[] = [];
  private issued = 0;
  private publicKey: KeyObject;

  constructor(
    publicKey: KeyObject | string,
    readonly apiKey: string,
  ) {
    this.publicKey = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  }

  /** 지금 유효한 listenKey (발급할 때마다 새로 만든다) */
  get listenKey(): string {
    return `LK-${this.issued}`;
  }

  factory = (url: string): FutSocket => {
    const s = new FutSocket(url);
    this.sockets.push(s);
    queueMicrotask(() => (this.refuseSockets ? s.serverDrop() : s.serverOpen()));
    return s;
  };

  get live(): FutSocket[] {
    return this.sockets.filter((s) => s.opened && !s.closed);
  }

  event(ev: Record<string, unknown>): void {
    for (const s of this.live) s.serverSend(ev);
  }
  dropAll(): void {
    for (const s of this.live) s.serverDrop();
  }

  fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const params = Object.fromEntries(u.searchParams);
    const sigIdx = url.indexOf('&signature=');
    delete params.signature;
    this.calls.push({ method, origin: u.origin, path: u.pathname, params, headers, hasSignature: sigIdx >= 0 });

    if (headers['X-MBX-APIKEY'] !== this.apiKey) return new Response(JSON.stringify({ code: -2014, msg: 'API-key format invalid.' }), { status: 401 });
    const special = this.queue.shift();
    if (special) return special;

    if (u.pathname === '/fapi/v1/listenKey') {
      if (method === 'POST') {
        this.issued++;
        return new Response(JSON.stringify({ listenKey: this.listenKey }), { status: 200 });
      }
      if (method === 'PUT') {
        if (this.expireNextKeepalive) {
          this.expireNextKeepalive = false;
          return new Response(JSON.stringify({ code: -1125, msg: 'This listenKey does not exist.' }), { status: 400 });
        }
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }

    if (u.pathname === '/fapi/v3/positionRisk') {
      const signed = url.slice(url.indexOf('?') + 1, sigIdx);
      const signature = sigIdx < 0 ? '' : decodeURIComponent(url.slice(sigIdx + '&signature='.length));
      if (sigIdx < 0 || !verify(null, Buffer.from(signed, 'utf8'), this.publicKey, Buffer.from(signature, 'base64'))) {
        this.invalidSignatures++;
        return new Response(JSON.stringify({ code: -1022, msg: 'Signature for this request is not valid.' }), { status: 400 });
      }
      const rows = this.positions.map((p) => ({
        symbol: p.symbol, positionSide: p.positionSide ?? 'BOTH', positionAmt: p.positionAmt, entryPrice: p.entryPrice ?? p.markPrice,
        breakEvenPrice: '0', markPrice: p.markPrice, unRealizedProfit: '0', liquidationPrice: p.liquidationPrice, updateTime: Date.now(),
      }));
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });

  get fetchFn(): typeof fetch {
    return this.fetch as unknown as typeof fetch;
  }

  callsTo(path: string, method?: string) {
    return this.calls.filter((c) => c.path === path && (method === undefined || c.method === method));
  }
}

// ---- 사용자 데이터 이벤트 페이로드 (필드명은 공식 SDK 모델, endpoints.ts 주석 참고) ----
export const orderTradeUpdate = (o: { symbol: string; side: 'BUY' | 'SELL'; qty: number | string; price: number | string; orderId: number; tradeId: number; type?: string }) => ({
  e: 'ORDER_TRADE_UPDATE', E: Date.now(), T: Date.now(),
  o: { s: o.symbol, c: 'abc', S: o.side, o: 'MARKET', f: 'GTC', q: String(o.qty), p: '0', ap: String(o.price), x: o.type ?? 'TRADE', X: o.type === undefined || o.type === 'TRADE' ? 'FILLED' : 'NEW', i: o.orderId, l: String(o.qty), z: String(o.qty), L: String(o.price), N: 'USDT', n: '0', T: Date.now(), t: o.tradeId, ps: 'BOTH' },
});
export const accountUpdate = () => ({
  e: 'ACCOUNT_UPDATE', E: Date.now(), T: Date.now(),
  a: { m: 'ORDER', B: [{ a: 'USDT', wb: '100', cw: '100', bc: '0' }], P: [{ s: 'BTCUSDT', pa: '0.5', ep: '83000', cr: '0', up: '0', mt: 'cross', iw: '0', ps: 'BOTH' }] },
});
export const listenKeyExpired = () => ({ e: 'listenKeyExpired', E: Date.now(), listenKey: 'LK-old' });
