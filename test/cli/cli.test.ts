import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultCommands } from '../../src/cli/index.js';
import { parseSymbol } from '../../src/cli/parse.js';
import { suggest } from '../../src/cli/suggest.js';
import { displayWidth } from '../../src/cli/format.js';
import { t } from '../../src/i18n/index.js';
import { makeHarness, fakePresets, type Harness } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(() => h.cleanup());

describe('cli 입력 정규화', () => {
  it('AC-06 f: 접두사와 축약 심볼은 선물 전체 심볼로 저장된다', async () => {
    expect(await h.run('add price f:eth below 3000')).toBe(0);
    const [rule] = await h.deps.store.loadRules();
    expect(rule).toMatchObject({ market: 'futures', symbol: 'ETHUSDT', condition: { direction: 'below', price: 3000 } });
  });

  it('D-21 축약은 USDT를 붙이고 전체 심볼은 그대로 둔다', () => {
    expect(parseSymbol('btc')).toEqual({ market: 'spot', symbol: 'BTCUSDT' });
    expect(parseSymbol('ETHUSDC')).toEqual({ market: 'spot', symbol: 'ETHUSDC' });
    expect(parseSymbol('WBTC')).toEqual({ market: 'spot', symbol: 'WBTCUSDT' });
    expect(parseSymbol('F:sol')).toEqual({ market: 'futures', symbol: 'SOLUSDT' });
  });

  it('잘못된 심볼·가격은 종료 코드 1과 예시를 담은 메시지를 낸다', async () => {
    expect(await h.run('add price BT$C above 1')).toBe(1);
    expect(await h.run('add price BTC above -5')).toBe(1);
    expect(h.err.every((m) => m.includes('예'))).toBe(true);
  });
});

describe('cli add / list', () => {
  it('AC-02 add price 후 list는 ID 1, 현물 BTCUSDT, above 70000, 1회성을 보여준다', async () => {
    expect(await h.run('add price BTC above 70000')).toBe(0);
    expect(await h.run('list')).toBe(0);
    const table = h.out.at(-1)!;
    for (const s of ['1', '현물', 'BTCUSDT', 'above 70000', '1회성', '활성']) expect(table).toContain(s);
  });

  it('AC-15 --mode 없이 추가하면 유형별 기본 반복 정책이 적용된다', async () => {
    await h.run('add price BTC above 70000');
    await h.run('add change ETH 5% 1h');
    await h.run('add volume SOL x3');
    await h.run('add funding f:BTC above 0.05%');
    const rules = await h.deps.store.loadRules();
    expect(rules.map((r) => r.repeat)).toEqual([
      { kind: 'once' },
      { kind: 'cooldown', ms: 30 * 60_000 },
      { kind: 'cooldown', ms: 15 * 60_000 },
      { kind: 'hysteresis', widthPct: 20 },
    ]);
    expect(rules[1]!.condition).toMatchObject({ direction: 'both', windowMs: 3_600_000 });
    expect(rules[2]!.condition).toMatchObject({ multiple: 3, shortMs: 300_000, longMs: 3_600_000 });
  });

  it('FR-REP-03 --mode로 정책을 바꾸고 --sound, --name을 저장한다', async () => {
    await h.run('add change f:BTC 3% 15m --mode cooldown:10m --sound warn --name 급변');
    await h.run('add price BTC above 1 --mode=hyst:2%');
    const [a, b] = await h.deps.store.loadRules();
    expect(a).toMatchObject({ repeat: { kind: 'cooldown', ms: 600_000 }, sound: 'warn', name: '급변' });
    expect(b!.repeat).toEqual({ kind: 'hysteresis', widthPct: 2 });
  });

  it('AC-16 쿨다운 30초는 범위 오류(최소 1분) 안내와 종료 코드 1', async () => {
    expect(await h.run('add price BTC above 70000 --mode cooldown:30s')).toBe(1);
    expect(h.err[0]).toContain('1분~24시간');
    expect(await h.deps.store.loadRules()).toHaveLength(0);
  });

  it('펀딩비는 선물 심볼만, 음수 기준을 받는다', async () => {
    expect(await h.run('add funding BTC above 0.05%')).toBe(1);
    expect(await h.run('add funding f:BTC below -0.05%')).toBe(0);
    expect((await h.deps.store.loadRules())[0]!.condition).toMatchObject({ type: 'funding', pct: -0.05 });
  });

  it('구간·기간·인자 개수 오류는 사용법을 안내한다', async () => {
    expect(await h.run('add volume SOL x3 1h/5m')).toBe(1);
    expect(await h.run('add change ETH 5% 30s')).toBe(1);
    expect(await h.run('add price BTC above')).toBe(1);
    expect(h.err[2]).toContain('blert add price <심볼>');
  });

  it('--name이 있으면 list 심볼 열에 별칭을 함께 표시한다', async () => {
    await h.run('add price BTC above 70000 --name 목표가');
    await h.run('list');
    expect(h.out.at(-1)).toContain('BTCUSDT (목표가)');
  });

  it('list 열은 한글이 섞여도 정렬된다', async () => {
    await h.run('add price BTC above 70000');
    await h.run('add funding f:BTC above 0.05%');
    await h.run('list');
    const lines = h.out.at(-1)!.split('\n');
    const col = (l: string) => displayWidth(l.slice(0, l.indexOf('BTCUSDT') + 0));
    expect(col(lines[1]!)).toBe(col(lines[2]!));
  });
});

describe('cli 관리 명령', () => {
  it('AC-03 pause 2 → list → resume 2 → del all', async () => {
    for (const s of ['BTC', 'ETH', 'SOL']) await h.run(`add price ${s} above 1`);
    expect(await h.run('pause 2')).toBe(0);
    await h.run('list');
    const paused = h.out.at(-1)!.split('\n').find((l) => l.startsWith('2'))!;
    expect(paused).toContain('일시정지');
    expect(await h.run('resume 2')).toBe(0);
    await h.run('list');
    expect(h.out.at(-1)).not.toContain('일시정지');
    expect(await h.run('del all')).toBe(0);
    expect(await h.deps.store.loadRules()).toHaveLength(0);
  });

  it('발동이 끝난 1회성 규칙은 list에서 숨기고 list --all에서 비활성으로 보인다', async () => {
    await h.run('add price BTC above 70000');
    await h.deps.store.setEnabled(1, false);
    await h.deps.store.saveStates([{ ruleId: 1, armed: false, lastFiredAt: '2026-10-01T00:00:00.000Z' }]);
    await h.run('list');
    expect(h.out.join('\n')).toContain(t('list.hiddenNote', { count: 1 }));
    await h.run('list --all');
    expect(h.out.at(-1)).toContain('비활성');
  });

  it('없는 ID, 잘못된 지정은 종료 코드 1', async () => {
    expect(await h.run('del 9')).toBe(1);
    expect(await h.run('pause abc')).toBe(1);
    expect(await h.run('del al')).toBe(1);
    expect(h.err[2]).toContain('혹시 `all`?');
    expect(await h.run('del')).toBe(1);
  });
});

describe('cli 오타 제안·도움말', () => {
  it('AC-04 `blert lst`는 "혹시 `list`?"를 제안하고 종료 코드 1', async () => {
    expect(await h.run('lst')).toBe(1);
    expect(h.err[0]).toContain('혹시 `list`?');
  });

  it('제안 후보가 없으면 도움말 안내를 한다', async () => {
    expect(await h.run('zzzzzz')).toBe(1);
    expect(h.err[0]).toContain('blert --help');
    expect(suggest('lst', ['add', 'list'])).toBe('list');
    expect(suggest('list', ['list'])).toBeUndefined();
  });

  it('유형·방향·옵션 오타도 제안한다', async () => {
    expect(await h.run('add prise BTC above 1')).toBe(1);
    expect(h.err[0]).toContain('혹시 `price`?');
    expect(await h.run('add price BTC abve 1')).toBe(1);
    expect(h.err[1]).toContain('혹시 `above`?');
    expect(await h.run('add price BTC above 1 --mod once')).toBe(1);
    expect(h.err[2]).toContain('혹시 `--mode`?');
  });

  it('AC-05 모든 명령의 --help에 사용 예가 2개 이상, 고급 옵션은 --advanced에서만', async () => {
    for (const cmd of defaultCommands.filter((c) => !c.hidden)) {
      h.out.length = 0;
      expect(await h.run(`${cmd.name} --help`)).toBe(0);
      const text = h.out.join('\n');
      const examples = text.split(t('help.examplesHeader'))[1]!.split('\n').filter((l) => /^\s+(npx (@[\w-]+\/)?)?blert /.test(l));
      expect(examples.length, cmd.name).toBeGreaterThanOrEqual(2);
      expect(text, cmd.name).not.toContain('--mode');

      h.out.length = 0;
      await h.run(`${cmd.name} --help --advanced`);
      if (cmd.advancedKeys) expect(h.out.join('\n'), cmd.name).toContain('--mode');
    }
    h.out.length = 0;
    await h.run('--help');
    expect(h.out.join('\n')).not.toContain('--mode');
    h.out.length = 0;
    await h.run('--help --advanced');
    expect(h.out.join('\n')).toContain('--mode');
  });

  it('명령이 허용하지 않는 옵션은 거부한다', async () => {
    expect(await h.run('list --mode once')).toBe(1);
    expect(await h.run('add price BTC above 1 --all')).toBe(1);
  });
});

describe('cli init', () => {
  it('AC-01 고지 동의·소리 설정이 저장되고 선택한 프리셋 규칙이 등록된다', async () => {
    const installed: string[] = [];
    const hh = await makeHarness(['y', 'n', '1'], fakePresets(installed));
    expect(await hh.run('init')).toBe(0);
    expect(await hh.deps.store.loadConfig()).toMatchObject({ disclaimerAccepted: true, soundEnabled: false });
    expect(installed).toEqual(['major-swing']);
    expect(hh.out.join('\n')).toContain('blert run');
    await hh.cleanup();
  });

  it('NFR-LEGAL-01 고지를 먼저 보여주고, 동의하지 않으면 저장하지 않고 종료 코드 1', async () => {
    const hh = await makeHarness(['n']);
    expect(await hh.run('init')).toBe(1);
    expect(hh.out[0]).toContain('투자 조언이 아니며');
    expect((await hh.deps.store.loadConfig()).disclaimerAccepted).toBe(false);
    await hh.cleanup();
  });

  it('빈 입력은 기본값(소리 켬, 프리셋 안 함)이고, 입력이 끝나면 종료 코드 1', async () => {
    const hh = await makeHarness(['y', '', '']);
    expect(await hh.run('init')).toBe(0);
    expect(await hh.deps.store.loadConfig()).toMatchObject({ soundEnabled: true });
    const eof = await makeHarness(['y']);
    expect(await eof.run('init')).toBe(1);
    await hh.cleanup();
    await eof.cleanup();
  });

  it('알 수 없는 답변은 다시 묻고 3번 틀리면 중단한다', async () => {
    const hh = await makeHarness(['??', '??', '??']);
    expect(await hh.run('init')).toBe(1);
    expect(hh.asked).toHaveLength(3);
    await hh.cleanup();
  });
});
