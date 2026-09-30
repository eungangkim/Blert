import type { Alert, Market } from './types.js';

// v0.1 이벤트. v0.2 이후 이벤트는 해당 버전에서 추가한다 (B2).
// market.kline은 거래량 급증(D-25) 판정용 1분봉으로, 설계서 B2 표에 없어 사용자 승인(2026-09-30)으로 추가했다.
export type BlertEvent =
  | { type: 'market.ticker'; ts: string; market: Market; symbol: string; price: number; quoteVolume: number }
  | { type: 'market.kline'; ts: string; market: Market; symbol: string; openTime: string; quoteVolume: number; closed: boolean }
  | { type: 'market.funding'; ts: string; symbol: string; rate: number; nextFundingTime: string }
  | { type: 'rule.fired'; ts: string; alert: Alert }
  | { type: 'rules.changed'; ts: string; ruleIds: number[] }
  | { type: 'conn.status'; ts: string; stream: string; state: 'connecting' | 'open' | 'retrying' | 'closed'; attempt: number }
  | { type: 'conn.gap'; ts: string; from: string; to: string; reason: 'sleep' | 'disconnect' };

export type EventOf<T extends BlertEvent['type']> = Extract<BlertEvent, { type: T }>;
