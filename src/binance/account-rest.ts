import type { Credentials } from '../security/index.js';
import type { Logger } from '../shared/logger.js';
import { isAllowedUrl } from '../shared/network.js';

const LOG = 'binance.account.rest';
const RECV_WINDOW = 5000;
const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_AFTER_S = 60;
const MAX_RETRY_AFTER_S = 300;
const TRADES_PAGE = 1000;

export interface AccountRestOptions {
  /** 예: https://api.binance.com (테스트넷은 https://testnet.binance.vision) */
  base: string;
  allowedHosts: readonly string[];
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: Logger;
  timeoutMs?: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
}

export interface Trade {
  symbol: string;
  tradeId: number;
  orderId: number;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  time: number;
}

export type RestFailure = 'blocked' | 'network' | 'rate-limited' | 'invalid-symbol' | 'rejected' | 'http';
type Signed = { ok: true; body: unknown } | { ok: false; reason: RestFailure; status?: number; code?: number };

const num = (v: unknown): number => (typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN);

/**
 * 서명된 GET. 문서: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/request-security
 * 쿼리 문자열(timestamp 포함)을 Ed25519로 서명 → base64 → 퍼센트 인코딩하고 signature를 마지막에 붙인다.
 * 429/418이면 Retry-After만큼 쉬고 다시 시도한다. 로그에는 키·서명을 남기지 않는다 (NFR-SEC-01).
 */
async function signedGet(path: string, params: Record<string, string | number>, creds: Credentials, o: AccountRestOptions): Promise<Signed> {
  const fetchFn = o.fetchFn ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 0; ; attempt++) {
    const entries = [...Object.entries(params), ['recvWindow', RECV_WINDOW], ['timestamp', (o.now ?? Date.now)()]] as [string, string | number][];
    const query = entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    const url = `${o.base}${path}?${query}&signature=${encodeURIComponent(creds.sign(query))}`;
    if (!isAllowedUrl(url, o.allowedHosts)) {
      o.logger?.error(LOG, 'blocked request to a non-Binance host');
      return { ok: false, reason: 'blocked' };
    }

    let res: Response;
    try {
      res = await fetchFn(url, { headers: { 'X-MBX-APIKEY': creds.apiKey }, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
    } catch (e) {
      o.logger?.warn(LOG, `${path} request failed: ${e instanceof Error ? e.name : 'error'}`);
      return { ok: false, reason: 'network' };
    }

    if (res.status === 429 || res.status === 418) {
      const wait = Math.min(Number(res.headers.get('retry-after')) || DEFAULT_RETRY_AFTER_S, MAX_RETRY_AFTER_S);
      o.logger?.warn(LOG, `rate limited (${res.status}) on ${path}, waiting ${wait}s`);
      if (attempt >= MAX_RATE_LIMIT_RETRIES) return { ok: false, reason: 'rate-limited', status: res.status };
      await sleep(wait * 1000);
      continue;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (res.ok) return { ok: true, body };
    const code = typeof (body as { code?: unknown })?.code === 'number' ? (body as { code: number }).code : undefined;
    if (code === -1121) return { ok: false, reason: 'invalid-symbol', status: res.status, code };
    if (code === -2014 || code === -2015 || code === -1022 || res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'rejected', status: res.status, code };
    }
    o.logger?.warn(LOG, `${path} HTTP ${res.status}${code !== undefined ? ` code ${code}` : ''}`);
    return { ok: false, reason: 'http', status: res.status, code };
  }
}

/** 계정 잔고 전체 (GET /api/v3/account, weight 20) */
export async function fetchBalances(creds: Credentials, o: AccountRestOptions): Promise<{ ok: true; balances: Balance[] } | { ok: false; reason: RestFailure }> {
  const r = await signedGet('/api/v3/account', {}, creds, o);
  if (!r.ok) return { ok: false, reason: r.reason };
  const list = (r.body as { balances?: unknown })?.balances;
  if (!Array.isArray(list)) return { ok: false, reason: 'http' };
  const balances: Balance[] = [];
  for (const b of list as { asset?: unknown; free?: unknown; locked?: unknown }[]) {
    const free = num(b.free);
    const locked = num(b.locked);
    if (typeof b.asset === 'string' && Number.isFinite(free) && Number.isFinite(locked)) balances.push({ asset: b.asset, free, locked });
  }
  return { ok: true, balances };
}

/**
 * startTime 이후의 체결 (GET /api/v3/myTrades, symbol 필수, weight 20, 한 번에 최대 1000건).
 * 꽉 찬 쪽이 오면 마지막 체결 시각 다음부터 이어서 받는다.
 */
export async function fetchTrades(
  symbol: string,
  startTime: number,
  creds: Credentials,
  o: AccountRestOptions,
): Promise<{ ok: true; trades: Trade[] } | { ok: false; reason: RestFailure }> {
  const trades: Trade[] = [];
  let from = Math.max(0, Math.floor(startTime));
  for (;;) {
    const r = await signedGet('/api/v3/myTrades', { symbol, startTime: from, limit: TRADES_PAGE }, creds, o);
    if (!r.ok) return trades.length ? { ok: true, trades } : { ok: false, reason: r.reason }; // 받은 데이터까지는 쓴다
    const rows = Array.isArray(r.body) ? (r.body as Record<string, unknown>[]) : [];
    let last = from;
    for (const t of rows) {
      const tradeId = num(t.id);
      const orderId = num(t.orderId);
      const qty = num(t.qty);
      const price = num(t.price);
      const time = num(t.time);
      if (![tradeId, orderId, qty, price, time].every(Number.isFinite)) continue;
      trades.push({ symbol, tradeId, orderId, side: t.isBuyer === true ? 'BUY' : 'SELL', qty, price, time });
      last = Math.max(last, time);
    }
    if (rows.length < TRADES_PAGE) return { ok: true, trades };
    from = last + 1;
  }
}
