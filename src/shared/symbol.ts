// 스테이블 견적 통화만 전체 심볼로 인식한다. WBTC 같은 코인명이 견적 통화로 오인되지 않게 하려는 제한이다.
export const STABLE_QUOTES = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD'];

export function quoteAsset(symbol: string): string {
  return STABLE_QUOTES.find((q) => symbol.endsWith(q) && symbol.length > q.length) ?? 'USDT';
}

/** 체결 알림용: 스테이블 견적으로 끝나지 않는 쌍(ETHBTC 등)은 나누지 못하므로 quote를 비워 둔다 */
export function splitSymbol(symbol: string): { base: string; quote: string } {
  const q = STABLE_QUOTES.find((x) => symbol.endsWith(x) && symbol.length > x.length);
  return q ? { base: symbol.slice(0, -q.length), quote: q } : { base: symbol, quote: '' };
}

export function baseAsset(symbol: string): string {
  const q = STABLE_QUOTES.find((x) => symbol.endsWith(x) && symbol.length > x.length);
  return q ? symbol.slice(0, -q.length) : symbol;
}
