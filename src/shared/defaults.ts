import type { RepeatPolicy, RuleType } from './types.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 알림 유형별 기본 반복 정책 (B4, FR-REP-02) */
export const DEFAULT_REPEAT: Record<RuleType, RepeatPolicy> = {
  price: { kind: 'once' },
  change: { kind: 'cooldown', ms: 30 * MINUTE },
  volume: { kind: 'cooldown', ms: 15 * MINUTE },
  funding: { kind: 'hysteresis', widthPct: 20 },
  fill: { kind: 'each' },
  balance: { kind: 'cooldown', ms: 10 * MINUTE }, // D-27
  liq: { kind: 'cooldown', ms: 5 * MINUTE }, // B4: 청산가 근접 쿨다운 5분
};

/** 실행 잠금(blert.pid)의 생존 신호가 이만큼 끊기면 주인이 멈춘 것으로 본다 (D-35, D-61) */
export const RUN_LOCK_STALE_MS = 60_000;

/** 쿨다운 허용 범위 (B4: 1분 ~ 24시간) */
export const COOLDOWN_MIN_MS = MINUTE;
export const COOLDOWN_MAX_MS = DAY;
