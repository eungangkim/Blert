import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

describe('cli add liq / 선물 체결 (FR-ALERT-05, FR-ACC-03)', () => {
  it('AC-35 add liq f:BTC 5%는 선물 BTCUSDT 청산가 근접 규칙을 기본 쿨다운 5분으로 만든다', async () => {
    expect(await h.run('add liq f:BTC 5%')).toBe(0);
    expect(await h.run('add liq f:ethusdt 2.5% --mode cooldown:10m --name 이더')).toBe(0);
    const rules = await h.deps.store.loadRules();
    expect(rules[0]).toMatchObject({ type: 'liq', market: 'futures', symbol: 'BTCUSDT', condition: { type: 'liq', pct: 5 }, repeat: { kind: 'cooldown', ms: 300_000 } });
    expect(rules[1]).toMatchObject({ symbol: 'ETHUSDT', condition: { pct: 2.5 }, repeat: { kind: 'cooldown', ms: 600_000 }, name: '이더' });
    expect(h.out[0]).toContain('청산가까지 5% 이내');
  });

  it('AC-35 add liq 입력 오류: 현물 심볼, 퍼센트 형식·범위, 인자 개수는 종료 코드 1이고 예시를 보여준다', async () => {
    expect(await h.run('add liq BTC 5%')).toBe(1);
    expect(h.err.at(-1)).toContain('f:');
    expect(await h.run('add liq f:BTC 5')).toBe(1);
    expect(await h.run('add liq f:BTC 100%')).toBe(1);
    expect(await h.run('add liq f:BTC 0%')).toBe(1);
    expect(await h.run('add liq f:BTC')).toBe(1);
    expect(await h.run('add liq all 5%')).toBe(1); // 전체 감시는 지원하지 않는다 (D-51)
    expect(h.err.every((m) => m.includes('예'))).toBe(true);
    expect(await h.deps.store.loadRules()).toHaveLength(0);
  });

  it('AC-39 add fill f:BTC는 선물 체결 규칙을 이벤트마다 알림으로 만든다. 선물 전체(f:all)는 거부한다 (D-52)', async () => {
    expect(await h.run('add fill f:BTC')).toBe(0);
    expect(await h.run('add fill f:all')).toBe(1);
    expect(h.err.at(-1)).toContain('심볼을 지정');
    const rules = await h.deps.store.loadRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ type: 'fill', market: 'futures', symbol: 'BTCUSDT', repeat: { kind: 'each' } });
  });

  it('키가 없으면 청산가·선물 체결 규칙에도 키 등록 방법을 안내한다', async () => {
    await h.run('add liq f:BTC 5%');
    expect(h.out.join('\n')).toContain('API 키가 있어야 동작합니다');
  });

  it('list는 청산가 규칙을 선물 심볼과 조건으로 보여준다', async () => {
    await h.run('add liq f:BTC 5%');
    await h.run('add fill f:BTC');
    await h.run('list');
    const lines = h.out.at(-1)!.split('\n');
    expect(lines[1]).toMatch(/청산가.*선물.*BTCUSDT.*청산가까지 5% 이내.*쿨다운 5m/);
    expect(lines[2]).toMatch(/체결.*선물.*BTCUSDT.*주문 체결.*이벤트마다/);
  });
});
