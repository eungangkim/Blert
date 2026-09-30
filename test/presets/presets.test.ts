import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRESETS, createPresetService } from '../../src/presets/index.js';
import { DEFAULT_REPEAT } from '../../src/shared/defaults.js';
import { hasMessage, t } from '../../src/i18n/index.js';
import { parseSymbol } from '../../src/cli/parse.js';
import { makeHarness, type Harness } from '../cli/helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await makeHarness([], 'real');
});
afterEach(() => h.cleanup());

describe('presets 정의 (D-23)', () => {
  it('기본 프리셋 3종이 슬러그와 규칙 수대로 정의되어 있다', () => {
    expect(PRESETS.map((p) => [p.slug, p.rules.length])).toEqual([
      ['major-swing', 3],
      ['volume-burst', 5],
      ['futures-heat', 4],
    ]);
  });

  it('모든 프리셋은 표시 이름 키가 있고, 규칙은 정규화된 심볼과 올바른 시장을 가진다', () => {
    for (const p of PRESETS) {
      expect(hasMessage(p.nameKey), p.nameKey).toBe(true);
      for (const r of p.rules) {
        expect(r.condition.type).toBe(r.type);
        expect(parseSymbol(r.symbol).symbol).toBe(r.symbol);
        expect(r.market).toBe(r.type === 'funding' ? 'futures' : 'spot');
      }
    }
  });
});

describe('presets 설치·제거 (FR-PRE-01)', () => {
  it('AC-07 install → 규칙 3개가 preset:major-swing 출처로 추가되고 remove하면 그것만 삭제된다', async () => {
    await h.run('add price BTC above 70000');
    expect(await h.run('preset install major-swing')).toBe(0);
    let rules = await h.deps.store.loadRules();
    const preset = rules.filter((r) => r.source === 'preset:major-swing');
    expect(preset).toHaveLength(3);
    expect(preset.map((r) => r.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(preset[0]).toMatchObject({
      market: 'spot',
      enabled: true,
      condition: { type: 'change', pct: 5, windowMs: 3_600_000, direction: 'both' },
      repeat: DEFAULT_REPEAT.change,
    });
    expect((await h.deps.store.loadConfig()).presets).toEqual([{ slug: 'major-swing', version: 1 }]);
    expect(h.out.at(-1)).toContain('3개');

    expect(await h.run('preset remove major-swing')).toBe(0);
    rules = await h.deps.store.loadRules();
    expect(rules.map((r) => r.source)).toEqual(['manual']);
    expect((await h.deps.store.loadConfig()).presets).toEqual([]);
  });

  it('volume-burst는 5종 거래량 규칙, futures-heat는 펀딩비 위·아래 규칙을 기본 정책으로 만든다', async () => {
    await h.run('preset install volume-burst');
    await h.run('preset install futures-heat');
    const rules = await h.deps.store.loadRules();
    const vol = rules.filter((r) => r.source === 'preset:volume-burst');
    expect(vol.map((r) => r.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT']);
    expect(vol[0]).toMatchObject({ condition: { multiple: 3, shortMs: 300_000, longMs: 3_600_000 }, repeat: DEFAULT_REPEAT.volume });
    const heat = rules.filter((r) => r.source === 'preset:futures-heat');
    expect(heat.map((r) => [r.market, r.symbol, r.condition])).toEqual([
      ['futures', 'BTCUSDT', { type: 'funding', direction: 'above', pct: 0.05 }],
      ['futures', 'BTCUSDT', { type: 'funding', direction: 'below', pct: -0.05 }],
      ['futures', 'ETHUSDT', { type: 'funding', direction: 'above', pct: 0.05 }],
      ['futures', 'ETHUSDT', { type: 'funding', direction: 'below', pct: -0.05 }],
    ]);
    expect(heat.every((r) => r.repeat.kind === 'hysteresis')).toBe(true);
  });

  it('제거는 다른 프리셋과 사용자가 직접 만든 규칙을 건드리지 않는다', async () => {
    await h.run('preset install major-swing');
    await h.run('preset install volume-burst');
    await h.run('preset remove major-swing');
    expect((await h.deps.store.loadRules()).every((r) => r.source === 'preset:volume-burst')).toBe(true);
  });

  it('이미 설치된 프리셋을 다시 설치하거나 설치 안 된 프리셋을 제거하면 종료 코드 1', async () => {
    await h.run('preset install major-swing');
    expect(await h.run('preset install major-swing')).toBe(1);
    expect(h.err[0]).toContain('blert preset remove major-swing');
    expect(await h.deps.store.loadRules()).toHaveLength(3);
    expect(await h.run('preset remove volume-burst')).toBe(1);
    expect(h.err[1]).toContain('설치되어 있지 않습니다');
  });

  it('없는 프리셋은 목록과 오타 제안을 안내하고, 인자가 틀리면 사용법을 안내한다', async () => {
    expect(await h.run('preset install major-swng')).toBe(1);
    expect(h.err[0]).toContain('혹시 `major-swing`?');
    expect(await h.run('preset install zzz')).toBe(1);
    expect(h.err[1]).toContain('futures-heat');
    expect(await h.run('preset install')).toBe(1);
    expect(h.err[2]).toContain('blert preset install <이름>');
    expect(await h.run('preset instal major-swing')).toBe(1);
    expect(h.err[3]).toContain('혹시 `install`?');
    expect(await h.run('preset')).toBe(1);
    expect(await h.deps.store.loadRules()).toHaveLength(0);
  });

  it('슬러그는 대소문자를 구분하지 않는다', async () => {
    expect(await h.run('preset install MAJOR-SWING')).toBe(0);
    expect(await h.deps.store.loadRules()).toHaveLength(3);
  });

  it('rules.changed 콜백에 프리셋 규칙 ID가 전달된다', async () => {
    const { Store } = await import('../../src/store/index.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'blert-preset-'));
    const seen: number[][] = [];
    const store = new Store(dir, { onRulesChanged: (ids) => seen.push(ids) });
    const svc = createPresetService(store);
    await svc.install('major-swing');
    await svc.remove('major-swing');
    expect(seen).toEqual([[1, 2, 3], [1, 2, 3]]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('presets 표시 (FR-PRE-02)', () => {
  it('AC-08 preset list는 3종을 슬러그와 한글 이름으로 보여준다', async () => {
    expect(await h.run('preset list')).toBe(0);
    const out = h.out.at(-1)!;
    for (const s of ['major-swing', '메이저 급등락', 'volume-burst', '거래량 폭발', 'futures-heat', '선물 과열']) {
      expect(out).toContain(s);
    }
    expect(out.match(/미설치/g)).toHaveLength(3);
  });

  it('설치한 프리셋은 목록에서 설치됨으로 바뀐다', async () => {
    await h.run('preset install futures-heat');
    await h.run('preset list');
    const line = h.out.at(-1)!.split('\n').find((l) => l.startsWith('futures-heat'))!;
    expect(line).toContain('설치됨');
    expect(line).toContain('4');
  });
});

describe('init과 프리셋 연결', () => {
  it('AC-01 init에서 프리셋을 고르면 해당 규칙이 등록되고 config에 기록된다', async () => {
    const hh = await makeHarness(['y', 'y', '1'], 'real');
    expect(await hh.run('init')).toBe(0);
    const rules = await hh.deps.store.loadRules();
    expect(rules).toHaveLength(3);
    expect(rules.every((r) => r.source === 'preset:major-swing')).toBe(true);
    expect(hh.out.join('\n')).toContain(t('init.done', { count: 3 }));
    await hh.cleanup();
  });

  it('init을 다시 실행해 이미 설치된 프리셋을 고르면 중복 등록 없이 끝난다', async () => {
    const hh = await makeHarness(['y', 'y', '1'], 'real');
    await hh.deps.presets.install('major-swing');
    expect(await hh.run('init')).toBe(0);
    expect(await hh.deps.store.loadRules()).toHaveLength(3);
    expect(hh.out.join('\n')).toContain('(설치됨)');
    await hh.cleanup();
  });
});
