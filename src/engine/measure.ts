import type { Alert, Rule, SoundKind } from '../shared/types.js';
import { baseAsset, quoteAsset, splitSymbol } from '../shared/symbol.js';
import type { EventOf } from '../shared/events.js';
import { formatCompact, formatExact, formatPct, formatPctExact, formatPrice } from '../shared/format.js';

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
  /** true면 '넘는 순간'(미충족 → 충족)에만 발동한다. 가격·펀딩비. 변동률·거래량은 현재 수준을 본다. */
  edge?: boolean;
  kind: SoundKind;
  titleKey: string;
  params: Record<string, string | number>;
  /** 실제로 알림이 나간 뒤에 부른다 (잔고 알림이 기준을 옮기는 데 쓴다) */
  onFire?: () => void;
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
    edge: true,
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
      windowMs: c.windowMs, // notify가 '1시간' 같은 문장으로 바꾼다 (xxxMs → xxx)
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
      shortMs: c.shortMs,
      longMs: c.longMs,
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
    edge: true,
    kind: 'warn',
    titleKey: `alert.funding.${c.direction}.title`,
    params: { ...base(rule), rate: formatPct(ratePct, 3), threshold: formatPctExact(c.pct) },
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

/** 선물 포지션 한 방향의 청산 판정에 필요한 값 (account.position에서 온다) */
export interface PositionView {
  side: 'LONG' | 'SHORT';
  size: number;
  liqPrice: number;
}

/**
 * 청산가 근접 알림 (FR-ALERT-05, D-46~D-49). 거리 = |마크 − 청산가| ÷ 마크 × 100 (%).
 * 크기가 0이거나 청산가가 0인 방향(포지션 없음, 청산 위험 없음)은 제외하고, 롱·숏이 함께 있으면 가까운 쪽을 쓴다.
 * 수준 기반이라 edge를 쓰지 않는다: 시작할 때 이미 기준 안이면 바로 알리고, 반복은 쿨다운이 막는다 (D-47).
 */
export function measureLiq(rule: Rule, positions: PositionView[], mark: number | undefined): Measurement | null {
  const c = rule.condition;
  if (c.type !== 'liq' || mark === undefined || !(mark > 0)) return null;
  let nearest: { side: 'LONG' | 'SHORT'; liq: number; distance: number } | undefined;
  for (const p of positions) {
    if (!(p.size > 0) || !(p.liqPrice > 0)) continue;
    const distance = (Math.abs(mark - p.liqPrice) / mark) * 100;
    if (!nearest || distance < nearest.distance) nearest = { side: p.side, liq: p.liqPrice, distance };
  }
  if (!nearest) return null;
  return {
    value: nearest.distance,
    threshold: c.pct,
    direction: 'below',
    kind: 'warn',
    titleKey: 'alert.liq.title',
    params: { ...base(rule), side: nearest.side, distance: formatPct(nearest.distance, 1), mark: formatPrice(mark), liq: formatPrice(nearest.liq), threshold: formatPctExact(c.pct) },
  };
}

/** 체결 알림 (FR-ACC-01, FR-ACC-03). 이벤트마다 발동한다. 선물 체결은 제목에 '선물'을 붙인다. */
export function measureFill(rule: Rule, e: EventOf<'account.fill'>): Measurement | null {
  if (rule.condition.type !== 'fill') return null;
  const { base: coin, quote } = splitSymbol(e.symbol);
  return {
    value: 1,
    threshold: 1,
    direction: 'above',
    kind: 'account',
    titleKey: e.market === 'futures' ? 'alert.fill.futures.title' : 'alert.fill.title',
    params: { coin, quote, side: e.side, qty: formatExact(e.qty), price: formatExact(e.price) }, // side는 notify가 매수·매도로 번역
  };
}

/**
 * 잔고 알림 (FR-ACC-02, D-27). 기준은 마지막 알림 시점의 잔고(free+locked)다.
 * 기준이 없거나 0이면 알리지 않고 기준만 잡는다. 호출한 쪽이 기준을 보관하고, 알림이 나갔을 때만 onFire로 옮긴다.
 */
export function measureBalance(rule: Rule, asset: string, base: number, total: number, onFire: () => void): Measurement | null {
  if (rule.condition.type !== 'balance' || !(base > 0)) return null;
  const pct = ((total - base) / base) * 100;
  return {
    value: Math.abs(pct),
    threshold: rule.condition.pct,
    direction: 'above',
    kind: 'account',
    titleKey: 'alert.balance.title',
    params: { asset, pct: formatPct(pct, 1, true), from: formatExact(base), to: formatExact(total) },
    onFire,
  };
}
