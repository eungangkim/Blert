export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 철자가 2글자 이내로 다른 가장 가까운 후보 (FR-CLI-03). 후보 순서가 동점 우선순위. */
export function suggest(input: string, candidates: readonly string[], maxDistance = 2): string | undefined {
  const lower = input.toLowerCase();
  let best: string | undefined;
  let bestDist = maxDistance + 1;
  for (const c of candidates) {
    const d = levenshtein(lower, c.toLowerCase());
    if (d > 0 && d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}
