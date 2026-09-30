import type { Alert, Market } from './types.js';

// v0.1 이벤트. v0.2 이후 이벤트는 해당 버전에서 추가한다 (B2).
// market.kline은 변동률·거래량(D-25, D-33) 판정용 1분봉이다. 시작 시 REST 백필도 같은 이벤트로 발행한다.
export type BlertEvent =
  | { type: 'market.ticker'; ts: string; market: Market; symbol: string; price: number; quoteVolume: number }
  | { type: 'market.kline'; ts: string; market: Market; symbol: string; openTime: string; close: number; quoteVolume: number; closed: boolean }
  | { type: 'market.funding'; ts: string; symbol: string; rate: number; nextFundingTime: string }
  | { type: 'rule.fired'; ts: string; alert: Alert }
  | { type: 'rules.changed'; ts: string; ruleIds: number[] }
  | { type: 'conn.status'; ts: string; stream: string; state: 'connecting' | 'open' | 'retrying' | 'closed'; attempt: number }
  | { type: 'conn.gap'; ts: string; from: string; to: string; reason: 'sleep' | 'disconnect' };

export type EventOf<T extends BlertEvent['type']> = Extract<BlertEvent, { type: T }>;
