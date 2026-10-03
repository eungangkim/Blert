import type { Condition, RepeatPolicy, Rule } from '../shared/types.js';
import { formatDuration } from '../shared/format.js';
import { t } from '../i18n/index.js';

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
    case 'fill':
      return t('cond.fill');
    case 'balance':
      return t('cond.balance', { asset: c.asset === '*' ? t('asset.all') : c.asset, pct: c.pct });
    case 'liq':
      return t('cond.liq', { pct: c.pct });
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
    case 'each':
      return t('repeat.each');
  }
}

/** 규칙의 대상 이름. 계정 알림의 '*'는 전체, 잔고 알림은 자산이 조건에 있어 비워 둔다 */
export function symbolLabel(r: Pick<Rule, 'symbol' | 'condition'>): string {
  if (r.condition.type === 'balance') return '';
  return r.symbol === '*' ? t('asset.all') : r.symbol;
}

export function describeRule(r: Pick<Rule, 'market' | 'symbol' | 'condition' | 'repeat'>): string {
  return t('rule.summary', {
    market: t(`market.${r.market}`),
    symbol: symbolLabel(r),
    condition: describeCondition(r.condition),
    repeat: describeRepeat(r.repeat),
  }).replace(/ {2,}/g, ' ');
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

/** 사용자 PC의 지역 시각 M/D HH:MM:SS */
export function formatLocalDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return '?';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
