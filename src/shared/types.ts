export type Market = 'spot' | 'futures';

export type RepeatPolicy =
  | { kind: 'once' }
  | { kind: 'cooldown'; ms: number }
  | { kind: 'hysteresis'; widthPct: number };

export type SoundKind = 'up' | 'down' | 'account' | 'warn';

export interface Alert {
  ruleId: number;
  kind: SoundKind;
  titleKey: string;
  /** 문장에 채울 값. market(spot/futures)과 이름이 Ms로 끝나는 기간(ms)은 notify가 번역한다 (engine은 i18n을 쓰지 않는다, B2) */
  params: Record<string, string | number>;
  firedAt: string;
  /** 규칙의 --sound 지정 (B3 고급 옵션). 없으면 kind를 따르고, 'off'면 이 알림은 무음 */
  sound?: SoundKind | 'off';
}

// B4 "유형별 조건" 구체화 (v0.1 유형만). 퍼센트 값은 5% → 5 처럼 % 단위 숫자로 저장한다.
export type Condition =
  | { type: 'price'; direction: 'above' | 'below'; price: number }
  | { type: 'change'; pct: number; windowMs: number; direction: 'up' | 'down' | 'both' }
  | { type: 'volume'; multiple: number; shortMs: number; longMs: number }
  | { type: 'funding'; direction: 'above' | 'below'; pct: number };

export type RuleType = Condition['type'];

export interface Rule {
  id: number;
  type: RuleType;
  market: Market;
  symbol: string;
  condition: Condition;
  repeat: RepeatPolicy;
  sound?: SoundKind | 'off';
  name?: string;
  source: 'manual' | `preset:${string}`;
  enabled: boolean;
  createdAt: string;
}

export interface RuleState {
  ruleId: number;
  lastFiredAt?: string;
  armed: boolean;
}
