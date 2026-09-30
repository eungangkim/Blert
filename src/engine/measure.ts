import type { Alert, Rule, SoundKind } from '../shared/types.js';
import { baseAsset, quoteAsset } from '../shared/symbol.js';
import { formatCompact, formatDuration, formatExact, formatPct, formatPrice } from '../shared/format.js';

/**
 * 규칙 조건을 '값 · 기준 · 방향' 하나로 줄인 측정 결과.
 * 발동 여부(satisfied)와 히스테리시스 재무장(rearmed)을 유형과 무관하게 같은 식으로 계산하기 위함이다.
 */
export interface Measurement {
  value: number;
  threshold: number;
  direction: 'above' | 'below';
  /** true면 기준과 같을 때는 미충족 (펀딩비 '초과') */
  strict?: boolean;
  kind: SoundKind;
  titleKey: string;
  params: Record<string, string | number>;
}

export function satisfied(m: Measurement): boolean {
  if (m.direction === 'above') return m.strict ? m.value > m.threshold : m.value >= m.threshold;
  return m.strict ? m.value < m.threshold : m.value <= m.threshold;
}

/** 기준에서 폭(기준값 대비 %)만큼 반대로 벗어났는가 (히스테리시스 재무장) */
export function rearmed(m: Measurement, widthPct: number): boolean {
  const gap = (Math.abs(m.threshold) * widthPct) / 100;
  return m.direction === 'above' ? m.value <= m.threshold - gap : m.value >= m.threshold + gap;
}

const base = (rule: Rule) => ({
  coin: baseAsset(rule.symbol),
  quote: quoteAsset(rule.symbol),
  market: rule.market, // notify가 market.<값> 키로 번역한다
});

export function measurePrice(rule: Rule, price: number): Measurement | null {
  const c = rule.condition;
  if (c.type !== 'price') return null;
  return {
    value: price,
    threshold: c.price,
    direction: c.direction,
    kind: c.direction === 'above' ? 'up' : 'down',
    titleKey: `alert.price.${c.direction}.title`,
    params: { ...base(rule), target: formatExact(c.price), price: formatPrice(price) },
  };
}

/** basePrice: 기간 전 가격. 없으면(이력 부족) null */
export function measureChange(rule: Rule, price: number, basePrice: number | undefined): Measurement | null {
  const c = rule.condition;
  if (c.type !== 'change' || basePrice === undefined || basePrice <= 0) return null;
  const pct = ((price - basePrice) / basePrice) * 100;
  const dir = c.direction === 'both' ? (pct >= 0 ? 'up' : 'down') : c.direction;
  return {
    // 양방향은 변동폭의 크기로 판정한다
    value: c.direction === 'both' ? Math.abs(pct) : pct,
    threshold: c.direction === 'down' ? -c.pct : c.pct,
    direction: c.direction === 'down' ? 'below' : 'above',
    kind: dir,
    titleKey: 'alert.change.title',
    params: {
      ...base(rule),
      window: formatDuration(c.windowMs),
      pct: formatPct(pct, 1, true),
      from: formatPrice(basePrice),
      to: formatPrice(price),
    },
  };
}

export function measureVolume(rule: Rule, shortSum: number, longSum: number): Measurement | null {
  const c = rule.condition;
  if (c.type !== 'volume') return null;
  const avg = (longSum * c.shortMs) / c.longMs; // 긴 구간을 짧은 구간 단위로 나눈 평균
  if (!(avg > 0)) return null;
  const ratio = shortSum / avg;
  return {
    value: ratio,
    threshold: c.multiple,
    direction: 'above',
    kind: 'up',
    titleKey: 'alert.volume.title',
    params: {
      ...base(rule),
      ratio: (Math.round(ratio * 10) / 10).toFixed(1),
      short: formatDuration(c.shortMs),
      long: formatDuration(c.longMs),
      shortVol: formatCompact(shortSum),
      avgVol: formatCompact(avg),
    },
  };
}

/** ratePct: % 단위 펀딩비 (바이낸스 응답 비율 × 100) */
export function measureFunding(rule: Rule, ratePct: number): Measurement | null {
  const c = rule.condition;
  if (c.type !== 'funding') return null;
  return {
    value: ratePct,
    threshold: c.pct,
    direction: c.direction,
    strict: true,
    kind: 'warn',
    titleKey: `alert.funding.${c.direction}.title`,
    params: { ...base(rule), rate: formatPct(ratePct, 3), threshold: formatPct(c.pct, 3) },
  };
}

export function toAlert(rule: Rule, m: Measurement, firedAtIso: string): Alert {
  return {
    ruleId: rule.id,
    kind: m.kind,
    titleKey: m.titleKey,
    params: m.params,
    firedAt: firedAtIso,
    ...(rule.sound ? { sound: rule.sound } : {}),
  };
}
