import type { BlertEvent } from '../shared/events.js';
import type { Logger } from '../shared/logger.js';
import type { Market } from '../shared/types.js';
import { iso } from '../shared/clock.js';
import { ALLOWED_HOSTS, ENDPOINTS, LIMITS, isAllowedUrl, type Endpoints } from './endpoints.js';

const MINUTE = 60_000;
const LOG = 'binance.rest';
const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_AFTER_S = 60;
const MAX_RETRY_AFTER_S = 300;

export interface RestOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: Logger;
  rest?: Endpoints['rest'];
  allowedHosts?: readonly string[];
}

export type KlineResult =
  | { ok: true; events: BlertEvent[] }
  | { ok: false; reason: 'invalid-symbol' | 'rate-limited' | 'failed' | 'blocked'; events: BlertEvent[] };

/**
 * 1분봉 백필. fromMs부터 지금까지를 시간순 market.kline 이벤트로 돌려준다 (D-33).
 * 응답 행: [0]=시작, [4]=종가, [6]=종료, [7]=quote asset volume (문서 링크는 endpoints.ts).
 * 429/418이면 Retry-After만큼 쉬고 다시 시도하며, 반복되면 경고를 남기고 포기한다 (B5 레이트 리밋).
 */
export async function fetchKlineEvents(market: Market, symbol: string, fromMs: number, opts: RestOptions = {}): Promise<KlineResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const base = (opts.rest ?? ENDPOINTS.rest)[market];
  const events: BlertEvent[] = [];
  const nowMs = now();
  let cursor = Math.floor(fromMs / MINUTE) * MINUTE;

  while (cursor <= nowMs) {
    const url = `${base}?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${cursor}&limit=${LIMITS[market].klineLimit}`;
    if (!isAllowedUrl(url, opts.allowedHosts ?? ALLOWED_HOSTS)) {
      opts.logger?.error(LOG, 'blocked request to a non-Binance host');
      return { ok: false, reason: 'blocked', events };
    }

    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetchFn(url);
      } catch (e) {
        opts.logger?.warn(LOG, `klines request failed for ${symbol}: ${String(e)}`);
        return { ok: false, reason: 'failed', events };
      }
      if (res.status !== 429 && res.status !== 418) break;
      const retryAfter = Math.min(Number(res.headers.get('retry-after')) || DEFAULT_RETRY_AFTER_S, MAX_RETRY_AFTER_S);
      opts.logger?.warn(LOG, `rate limited (${res.status}), waiting ${retryAfter}s`);
      if (attempt >= MAX_RATE_LIMIT_RETRIES) return { ok: false, reason: 'rate-limited', events };
      await sleep(retryAfter * 1000);
    }

    if (res.status === 400) {
      opts.logger?.warn(LOG, `invalid symbol or request for ${market}:${symbol}`);
      return { ok: false, reason: 'invalid-symbol', events };
    }
    if (!res.ok) {
      opts.logger?.warn(LOG, `klines HTTP ${res.status} for ${symbol}`);
      return { ok: false, reason: 'failed', events };
    }

    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return { ok: false, reason: 'failed', events };
    for (const row of rows as unknown[][]) {
      const open = Number(row[0]);
      const close = Number(row[4]);
      const closeTime = Number(row[6]);
      const quoteVolume = Number(row[7]);
      if (![open, close, closeTime, quoteVolume].every(Number.isFinite)) continue;
      events.push({
        type: 'market.kline', ts: iso(nowMs), market, symbol,
        openTime: iso(open), close, quoteVolume, closed: closeTime < nowMs,
      });
    }
    if (rows.length < LIMITS[market].klineLimit) break;
    cursor = Number((rows[rows.length - 1] as unknown[])[0]) + MINUTE;
  }
  return { ok: true, events };
}
