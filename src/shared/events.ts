import type { Alert, Market } from './types.js';

// v0.1 이벤트. v0.2 이후 이벤트는 해당 버전에서 추가한다 (B2).
// market.kline은 변동률·거래량(D-25, D-33) 판정용 1분봉이다. 시작 시 REST 백필도 같은 이벤트로 발행한다.
export type BlertEvent =
  | { type: 'market.ticker'; ts: string; market: Market; symbol: string; price: number; quoteVolume: number }
  | { type: 'market.kline'; ts: string; market: Market; symbol: string; openTime: string; close: number; quoteVolume: number; closed: boolean }
  // markPrice: 마크 가격 스트림의 현재 마크 가격 (v0.3 청산가 판정용, D-46)
  | { type: 'market.funding'; ts: string; symbol: string; rate: number; nextFundingTime: string; markPrice?: number }
  // v0.2 계정 이벤트 (바이낸스 사용자 데이터 스트림). tradeId는 재연결 후 보충 조회와의 중복 제거용이다.
  | { type: 'account.fill'; ts: string; market: Market; symbol: string; side: 'BUY' | 'SELL'; qty: number; price: number; orderId: number; tradeId: number }
  | { type: 'account.balance'; ts: string; asset: string; free: number; locked: number }
  // v0.3 선물 포지션 (포지션 조회 또는 계정 갱신 때마다). size는 절댓값이고 0이면 그 방향 포지션이 없다는 뜻이다 (B2).
  | { type: 'account.position'; ts: string; symbol: string; side: 'LONG' | 'SHORT'; size: number; entryPrice: number; liqPrice: number; markPrice: number }
  // 키 때문에 계정 기능을 쓸 수 없을 때. fields는 문제가 된 권한 이름이다.
  | { type: 'key.denied'; ts: string; reason: 'trade' | 'withdraw' | 'hmac' | 'no-keychain'; fields?: string[] }
  | { type: 'rule.fired'; ts: string; alert: Alert }
  | { type: 'rules.changed'; ts: string; ruleIds: number[] }
  | { type: 'conn.status'; ts: string; stream: string; state: 'connecting' | 'open' | 'retrying' | 'closed'; attempt: number }
  // ongoing: 5분 넘게 끊긴 채로 아직 복구되지 않았음을 알리는 경고. 없으면 끝난 감시 중단 구간이다.
  // reason exit: 이전 실행이 정상 종료하지 못해(강제 종료, 보안 프로그램, 정전 등) 생긴 중단 구간.
  | { type: 'conn.gap'; ts: string; from: string; to: string; reason: 'sleep' | 'disconnect' | 'exit'; ongoing?: boolean };

export type EventOf<T extends BlertEvent['type']> = Extract<BlertEvent, { type: T }>;
