import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPresetService, parseExternalPreset, type ExternalPreset } from '../../src/presets/index.js';
import { Store } from '../../src/store/index.js';
import { BlertError } from '../../src/shared/errors.js';
import { presetText } from './extfixture.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blert-extpreset-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const parse = (over: Record<string, unknown> = {}): ExternalPreset => {
  const r = parseExternalPreset(presetText(over));
  if (!r.ok) throw new Error('fixture invalid');
  return r.value;
};
const origin = { source: 'file', sha256: 'a'.repeat(64) };

describe('외부 프리셋 설치 (FR-PRE-03)', () => {
  it('AC-85 규칙이 preset:<슬러그> 출처로 추가되고 설정에 이름·버전·출처·해시가 기록된다', async () => {
    const store = new Store(dir);
    const svc = createPresetService(store);
    expect(await svc.installExternal(parse(), origin)).toBe(3);
    const rules = await store.loadRules();
    expect(rules).toHaveLength(3);
    expect(rules.every((r) => r.source === 'preset:btc-breakout' && r.enabled)).toBe(true);
    expect(rules[1]).toMatchObject({ sound: 'warn', name: 'ETH 급변' });
    expect((await store.loadConfig()).presets).toEqual([{ slug: 'btc-breakout', version: 2, name: 'BTC 돌파 감시', source: 'file', sha256: 'a'.repeat(64) }]);
  });

  it('AC-90 파일이 주장한 출처와 상관없이 규칙의 source는 preset:<슬러그>다', async () => {
    const store = new Store(dir);
    const rule = { type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 1 }, source: 'manual' };
    await createPresetService(store).installExternal(parse({ rules: [rule] }), origin);
    expect((await store.loadRules())[0]!.source).toBe('preset:btc-breakout');
  });

  it('AC-89 내장 슬러그와 이미 설치된 슬러그는 거절하고 규칙을 추가하지 않는다', async () => {
    const store = new Store(dir);
    const svc = createPresetService(store);
    expect(await svc.slugConflict('major-swing')).toBe('builtin');
    await expect(svc.installExternal(parse({ slug: 'major-swing' }), origin)).rejects.toMatchObject({ messageKey: 'err.presetBuiltinName' });
    await svc.installExternal(parse(), origin);
    expect(await svc.slugConflict('btc-breakout')).toBe('installed');
    await expect(svc.installExternal(parse(), origin)).rejects.toMatchObject({ messageKey: 'err.presetInstalled' });
    expect(await store.loadRules()).toHaveLength(3);
  });

  it('AC-85 내장 프리셋 설치는 기록에 name·source·sha256을 남기지 않는다 (옛 형식 유지)', async () => {
    const store = new Store(dir);
    await createPresetService(store).install('major-swing');
    expect((await store.loadConfig()).presets).toEqual([{ slug: 'major-swing', version: 1 }]);
  });

  it('AC-92 list에 외부 프리셋의 출처·해시가 보이고 remove는 그 출처의 규칙만 지운다', async () => {
    const store = new Store(dir);
    const svc = createPresetService(store);
    await svc.install('volume-burst');
    await svc.installExternal(parse(), { source: 'cdn.example.com/p/a.json', sha256: 'b'.repeat(64) });
    await store.addRules([{ type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 1 }, repeat: { kind: 'once' }, source: 'manual', enabled: true }]);

    const ext = (await svc.list()).find((p) => p.slug === 'btc-breakout')!;
    expect(ext).toMatchObject({ name: 'BTC 돌파 감시', ruleCount: 3, installed: true, source: 'cdn.example.com/p/a.json', sha256: 'b'.repeat(64) });
    expect(ext.nameKey).toBeUndefined();

    expect(await svc.remove('btc-breakout')).toBe(3);
    const left = await store.loadRules();
    expect(left.some((r) => r.source === 'preset:btc-breakout')).toBe(false);
    expect(left.some((r) => r.source === 'manual')).toBe(true);
    expect(left.some((r) => r.source === 'preset:volume-burst')).toBe(true);
    expect((await store.loadConfig()).presets.map((p) => p.slug)).toEqual(['volume-burst']);
    expect((await svc.list()).some((p) => p.slug === 'btc-breakout')).toBe(false);
  });

  it('AC-92 설치되지 않은 외부 슬러그를 지우려 하면 안내한다', async () => {
    const svc = createPresetService(new Store(dir));
    await expect(svc.remove('never-installed')).rejects.toBeInstanceOf(BlertError);
  });

  it('AC-85 설치한 외부 프리셋은 새 Store 인스턴스(재시작)에서도 남아 있다', async () => {
    await createPresetService(new Store(dir)).installExternal(parse(), origin);
    const again = createPresetService(new Store(dir));
    expect((await again.list()).find((p) => p.slug === 'btc-breakout')?.installed).toBe(true);
    expect(await again.remove('btc-breakout')).toBe(3);
  });

  it('AC-88 설정 기록이 실패하면 추가한 규칙을 지워 되돌린다 (D-109)', async () => {
    const store = new Store(dir);
    const svc = createPresetService(store);
    vi.spyOn(store, 'updateConfig').mockRejectedValueOnce(new Error('disk full'));
    await expect(svc.installExternal(parse(), origin)).rejects.toThrow('disk full');
    expect(await store.loadRules()).toEqual([]);
    expect((await store.loadConfig()).presets).toEqual([]);
  });

  it('AC-93 다른 프로세스가 설치하면 규칙 파일 감시가 변경을 알린다 (재시작 불필요)', async () => {
    const watcher = new Store(dir);
    const changed = new Promise<void>((resolve) => {
      const off = watcher.watchRules(() => {
        off();
        resolve();
      }, { pollMs: 50, debounceMs: 20 });
    });
    await createPresetService(new Store(dir)).installExternal(parse(), origin);
    await changed;
    expect((await watcher.loadRules()).length).toBe(3);
  });
});
