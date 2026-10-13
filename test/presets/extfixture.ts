/** 시험용 외부 프리셋 파일 내용 (D-101). 필요한 부분만 덮어써서 쓴다 */
export function presetJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    slug: 'btc-breakout',
    version: 2,
    name: 'BTC 돌파 감시',
    description: '시험용 프리셋',
    license: 'CC0-1.0',
    author: '시험',
    rules: [
      { type: 'price', market: 'futures', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 84500 }, repeat: { kind: 'cooldown', ms: 300000 } },
      { type: 'change', market: 'spot', symbol: 'ETHUSDT', condition: { type: 'change', pct: 5, windowMs: 3600000, direction: 'both' }, sound: 'warn', name: 'ETH 급변' },
      { type: 'funding', market: 'futures', symbol: 'BTCUSDT', condition: { type: 'funding', direction: 'above', pct: 0.05 } },
    ],
    ...over,
  };
}

export const presetText = (over: Record<string, unknown> = {}): string => JSON.stringify(presetJson(over));
