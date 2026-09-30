import type { Condition, RepeatPolicy, Rule } from '../shared/types.js';
import { t } from '../i18n/index.js';

export function formatDuration(ms: number): string {
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

export function describeCondition(c: Condition): string {
  switch (c.type) {
    case 'price':
      return t('cond.price', { direction: c.direction, price: c.price });
    case 'change':
      return t('cond.change', {
        pct: c.pct,
        window: formatDuration(c.windowMs),
        direction: c.direction === 'both' ? t('dir.both') : c.direction,
      });
    case 'volume':
      return t('cond.volume', { multiple: c.multiple, short: formatDuration(c.shortMs), long: formatDuration(c.longMs) });
    case 'funding':
      return t('cond.funding', { direction: c.direction, pct: c.pct });
  }
}

export function describeRepeat(r: RepeatPolicy): string {
  switch (r.kind) {
    case 'once':
      return t('repeat.once');
    case 'cooldown':
      return t('repeat.cooldown', { duration: formatDuration(r.ms) });
    case 'hysteresis':
      return t('repeat.hysteresis', { pct: r.widthPct });
  }
}

export function describeRule(r: Pick<Rule, 'market' | 'symbol' | 'condition' | 'repeat'>): string {
  return t('rule.summary', {
    market: t(`market.${r.market}`),
    symbol: r.symbol,
    condition: describeCondition(r.condition),
    repeat: describeRepeat(r.repeat),
  });
}

/** 터미널에서 한글·전각 문자는 2칸을 차지한다 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

export function renderTable(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...rows.map((r) => displayWidth(r[i] ?? ''))));
  return rows
    .map((r) =>
      r
        .map((cell, i) => cell + ' '.repeat(widths[i]! - displayWidth(cell)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
