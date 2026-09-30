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
  params: Record<string, string | number>;
  firedAt: string;
}
