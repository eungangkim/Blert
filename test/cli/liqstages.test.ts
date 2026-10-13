import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

describe('cli add liq 단계별 (FR-ALERT-06, D-118)', () => {
  it('AC-102 add liq f:BTC 10%,5%,2%는 단계 규칙을 만들고 첫 값을 pct로 둔다', async () => {
    expect(await h.run('add liq f:BTC 10%,5%,2%')).toBe(0);
    const [rule] = await h.deps.store.loadRules();
    expect(rule).toMatchObject({ type: 'liq', market: 'futures', symbol: 'BTCUSDT', condition: { type: 'liq', pct: 10, stages: [10, 5, 2] }, repeat: { kind: 'cooldown', ms: 300_000 } });
    expect(h.out[0]).toContain('청산가까지 10%, 5%, 2% 이내 (3단계)');
  });

  it('AC-102 2~4단계와 소수, 쿨다운 지정을 받는다', async () => {
    expect(await h.run('add liq f:BTC 10%,5%')).toBe(0);
    expect(await h.run('add liq f:ETH 20%,10%,5.5%,2.5% --mode cooldown:10m')).toBe(0);
    const rules = await h.deps.store.loadRules();
    expect(rules[0]!.condition).toMatchObject({ stages: [10, 5] });
    expect(rules[1]).toMatchObject({ condition: { pct: 20, stages: [20, 10, 5.5, 2.5] }, repeat: { kind: 'cooldown', ms: 600_000 } });
  });

  it.each([
    ['오름차순', 'add liq f:BTC 2%,5%,10%'],
    ['같은 값', 'add liq f:BTC 10%,10%'],
    ['5단계', 'add liq f:BTC 50%,40%,30%,20%,10%'],
    ['100% 이상', 'add liq f:BTC 100%,5%'],
    ['0%', 'add liq f:BTC 5%,0%'],
    ['퍼센트 기호 없음', 'add liq f:BTC 10,5'],
    ['빈 값', 'add liq f:BTC 10%,,5%'],
  ])('AC-102 %s는 거부하고 종료 코드 1과 예시를 안내', async (_name, cmd) => {
    expect(await h.run(cmd)).toBe(1);
    expect(h.err.at(-1)).toContain('예');
    expect(await h.deps.store.loadRules()).toEqual([]);
  });

  it('AC-102 단계 규칙에 --mode once·hyst는 거부 (쿨다운만)', async () => {
    expect(await h.run('add liq f:BTC 10%,5% --mode once')).toBe(1);
    expect(h.err.at(-1)).toContain('쿨다운');
    expect(await h.run('add liq f:BTC 10%,5% --mode hyst:20%')).toBe(1);
    expect(await h.deps.store.loadRules()).toEqual([]);
  });

  it('AC-102 값이 하나면 기존과 같다 (stages 없음), 현물 심볼은 여전히 거부', async () => {
    expect(await h.run('add liq f:BTC 5%')).toBe(0);
    expect((await h.deps.store.loadRules())[0]!.condition).toEqual({ type: 'liq', pct: 5 });
    expect(await h.run('add liq BTC 10%,5%')).toBe(1);
  });

  it('AC-104 list에 단계가 보인다', async () => {
    await h.run('add liq f:BTC 10%,5%,2%');
    h.out.length = 0;
    expect(await h.run('list')).toBe(0);
    expect(h.out.join('\n')).toContain('(3단계)');
  });
});
