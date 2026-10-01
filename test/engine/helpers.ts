import type { BlertEvent } from '../../src/shared/events.js';
import type { Condition, RepeatPolicy, Rule } from '../../src/shared/types.js';
import { iso } from '../../src/shared/clock.js';

export const T0 = Date.UTC(2026, 9, 3, 0, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;

let nextId = 1;
export function rule(
  condition: Condition,
  repeat: RepeatPolicy,
  opts: { market?: 'spot' | 'futures'; symbol?: string; id?: number } = {},
): Rule {
  return {
    id: opts.id ?? nextId++,
    type: condition.type,
    market: opts.market ?? (condition.type === 'funding' ? 'futures' : 'spot'),
    symbol: opts.symbol ?? 'BTCUSDT',
    condition,
    repeat,
    source: 'manual',
    enabled: true,
    createdAt: iso(T0),
  };
}

export const ticker = (ts: number, price: number, market: 'spot' | 'futures' = 'spot', symbol = 'BTCUSDT'): BlertEvent => ({
  type: 'market.ticker', ts: iso(ts), market, symbol, price, quoteVolume: 0,
});

export const kline = (openTs: number, quoteVolume: number, opts: { close?: number; closed?: boolean; now?: number; symbol?: string } = {}): BlertEvent => ({
  type: 'market.kline',
  ts: iso(opts.now ?? openTs + MIN - 1),
  market: 'spot',
  symbol: opts.symbol ?? 'BTCUSDT',
  openTime: iso(openTs),
  close: opts.close ?? 100,
  quoteVolume,
  closed: opts.closed ?? true,
});

/** 펀딩비 rate는 % 단위로 받아 바이낸스 응답처럼 비율(÷100)로 바꾼다 */
export const funding = (ts: number, ratePct: number, symbol = 'BTCUSDT'): BlertEvent => ({
  type: 'market.funding', ts: iso(ts), symbol, rate: ratePct / 100, nextFundingTime: iso(ts + 8 * HOUR),
});

export const fill = (
  ts: number,
  symbol: string,
  side: 'BUY' | 'SELL',
  qty: number,
  price: number,
  ids: { orderId?: number; tradeId?: number } = {},
): BlertEvent => ({
  type: 'account.fill', ts: iso(ts), market: 'spot', symbol, side, qty, price, orderId: ids.orderId ?? 1, tradeId: ids.tradeId ?? 1,
});

export const balance = (ts: number, asset: string, free: number, locked = 0): BlertEvent => ({
  type: 'account.balance', ts: iso(ts), asset, free, locked,
});
