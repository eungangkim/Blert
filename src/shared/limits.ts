import { COOLDOWN_MAX_MS, COOLDOWN_MIN_MS } from './defaults.js';
import { STABLE_QUOTES } from './symbol.js';

/**
 * 알림 규칙 값의 허용 범위 (D-104). `blert add`의 명령줄 파서와 외부 프리셋 검증기가 같은 한도를 쓴다.
 * 한쪽 경로에서만 통과하는 값이 생기지 않도록, 범위를 바꿀 때는 여기만 고친다.
 */

/** 견적 통화를 뺀 코인 이름 또는 전체 심볼의 본문 (대문자·숫자 2~20자) */
export const SYMBOL_BODY = /^[A-Z0-9]{2,20}$/;
/** 계정 알림의 자산 이름 */
export const ASSET_NAME = /^[A-Z0-9]{2,10}$/;

/** 변동률·거래량 구간과 쿨다운의 범위: 1분 ~ 24시간 (히스토리 메모리와 백필 한도, B4) */
export const WINDOW_MIN_MS = COOLDOWN_MIN_MS;
export const WINDOW_MAX_MS = COOLDOWN_MAX_MS;
export const inDurationRange = (ms: number): boolean => ms >= COOLDOWN_MIN_MS && ms <= COOLDOWN_MAX_MS;

/** 거래량 배수는 1보다 커야 한다 */
export const MULTIPLE_MIN_EXCLUSIVE = 1;
/** 히스테리시스 폭(%)의 상한 */
export const HYSTERESIS_MAX_PCT = 100;
/** 청산가 근접 거리(%)는 이 값 미만이어야 한다 */
export const LIQ_MAX_PCT_EXCLUSIVE = 100;

/** 스테이블 견적으로 끝나는 전체 심볼인가 (예: BTCUSDT). 코인 이름만(BTC)이면 false */
export function isFullSymbol(s: string): boolean {
  return SYMBOL_BODY.test(s) && STABLE_QUOTES.some((q) => s.endsWith(q) && s.length > q.length);
}
