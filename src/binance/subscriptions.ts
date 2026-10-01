import type { Market, Rule } from '../shared/types.js';
import { streamName, type StreamKind } from './streams.js';

const MINUTE = 60_000;

/** 심볼 하나에 필요한 데이터. 규칙에서 계산한다 (binance는 store를 모른다). */
export interface StreamPlan {
  market: Market;
  symbol: string;
  ticker: boolean;
  kline: boolean;
  funding: boolean;
  /** 1분봉 백필이 필요한 기간 (0이면 백필 없음). 가장 긴 규칙 구간 + 여유 2분 (D-33) */
  backfillMs: number;
}

/** 활성 규칙이 필요로 하는 스트림만 구독하도록 계획을 만든다 (B5 규칙 변경) */
export function planSubscriptions(rules: Rule[]): StreamPlan[] {
  const plans = new Map<string, StreamPlan>();
  for (const r of rules) {
    // 계정 알림(체결·잔고)은 공개 스트림이 필요 없다. 계정 연결은 따로 관리한다 (v0.2)
    if (!r.enabled || r.condition.type === 'fill' || r.condition.type === 'balance') continue;
    const key = `${r.market}:${r.symbol}`;
    const plan = plans.get(key) ?? { market: r.market, symbol: r.symbol, ticker: false, kline: false, funding: false, backfillMs: 0 };
    plans.set(key, plan);
    const c = r.condition;
    if (c.type === 'price') plan.ticker = true;
    if (c.type === 'change') {
      plan.ticker = true;
      plan.kline = true;
      plan.backfillMs = Math.max(plan.backfillMs, c.windowMs + 2 * MINUTE);
    }
    if (c.type === 'volume') {
      plan.kline = true;
      plan.backfillMs = Math.max(plan.backfillMs, c.longMs + 2 * MINUTE);
    }
    if (c.type === 'funding') plan.funding = true;
  }
  return [...plans.values()];
}

export function streamsOf(plan: StreamPlan): string[] {
  const kinds: StreamKind[] = [];
  if (plan.ticker) kinds.push('ticker');
  if (plan.kline) kinds.push('kline');
  if (plan.funding) kinds.push('funding');
  return kinds.map((k) => streamName(k, plan.symbol));
}
