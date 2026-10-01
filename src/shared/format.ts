/** 알림·목록에 쓰는 숫자 표기 (B7: 천 단위 쉼표, 퍼센트 소수 첫째 자리, 펀딩비 셋째 자리) */

export function formatNumber(n: number, decimals: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * 가격 자릿수는 크기로 근사한다. 심볼별 호가 단위는 exchangeInfo 조회가 필요해 v0.1에서는 쓰지 않는다.
 */
export function formatPrice(n: number): string {
  const abs = Math.abs(n);
  const decimals = abs >= 1000 ? 0 : abs >= 10 ? 2 : abs >= 1 ? 3 : abs >= 0.1 ? 4 : 6;
  return formatNumber(n, decimals);
}

/** 사용자가 입력한 값을 자릿수 손실 없이 보여준다 (목표가 등). 천 단위 쉼표만 붙인다. */
export function formatExact(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

/** 입력한 퍼센트를 그대로 보여준다 (기준값 등). 음수는 유니코드 마이너스(−). */
export function formatPctExact(n: number): string {
  return `${n < 0 ? '−' : ''}${formatExact(Math.abs(n))}%`;
}

/** 부호를 붙이면 음수는 유니코드 마이너스(−)로 표기한다 */
export function formatPct(n: number, decimals = 1, signed = false): string {
  const body = formatNumber(Math.abs(n), decimals);
  const sign = n < 0 && Number(body.replace(/,/g, '')) !== 0 ? '−' : signed && n > 0 ? '+' : '';
  return `${sign}${body}%`;
}

export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${formatNumber(n / 1e9, 1)}B`;
  if (abs >= 1e6) return `${formatNumber(n / 1e6, 1)}M`;
  if (abs >= 1e3) return `${formatNumber(n / 1e3, 1)}K`;
  return formatNumber(n, 0);
}

/** 정확히 나누어떨어지는 가장 큰 단위로 표기한다. 예: 3600000 → 1h */
export function formatDuration(ms: number): string {
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}
