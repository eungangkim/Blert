import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/index.js';
import { readJson, type FileSpec } from '../../src/store/jsonfile.js';
import { withLock } from '../../src/store/lock.js';
import { BlertError } from '../../src/shared/errors.js';
import { FakeClock } from '../../src/shared/clock.js';
import type { Rule } from '../../src/shared/types.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blert-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const draft = (symbol: string, source: Rule['source'] = 'manual'): Omit<Rule, 'id' | 'createdAt'> => ({
  type: 'price',
  market: 'spot',
  symbol,
  condition: { type: 'price', direction: 'above', price: 70000 },
  repeat: { kind: 'once' },
  source,
  enabled: true,
});

describe('store', () => {
  it('AC-01 설정 폴더가 없어도 기본 설정을 읽고, 저장하면 schemaVersion이 최상단에 기록된다', async () => {
    const store = new Store(join(dir, 'new'));
    expect((await store.loadConfig()).disclaimerAccepted).toBe(false);
    await store.updateConfig((c) => {
      c.disclaimerAccepted = true;
      c.soundEnabled = false;
    });
    const raw = await readFile(join(dir, 'new', 'config.json'), 'utf8');
    expect(Object.keys(JSON.parse(raw))[0]).toBe('schemaVersion');
    expect(await new Store(join(dir, 'new')).loadConfig()).toMatchObject({ disclaimerAccepted: true, soundEnabled: false });
  });

  it('AC-02 규칙 ID는 1부터 순서대로 부여되고 삭제해도 재사용하지 않는다', async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 1));
    const store = new Store(dir, { clock });
    const [a] = await store.addRules([draft('BTCUSDT')]);
    expect(a).toMatchObject({ id: 1, createdAt: '2026-10-01T00:00:00.000Z' });
    await store.deleteRules(1);
    const [b] = await store.addRules([draft('ETHUSDT')]);
    expect(b!.id).toBe(2);
  });

  it('AC-03 pause → resume → del all', async () => {
    const store = new Store(dir);
    await store.addRules([draft('BTCUSDT'), draft('ETHUSDT'), draft('SOLUSDT')]);
    await store.setEnabled(2, false);
    expect((await store.loadRules()).map((r) => r.enabled)).toEqual([true, false, true]);
    await store.setEnabled(2, true);
    expect((await store.loadRules()).every((r) => r.enabled)).toBe(true);
    await store.deleteRules('all');
    expect(await store.loadRules()).toHaveLength(0);
  });

  it('없는 ID는 규칙을 바꾸지 않고 오류를 낸다', async () => {
    const store = new Store(dir);
    await store.addRules([draft('BTCUSDT')]);
    await expect(store.setEnabled(9, false)).rejects.toBeInstanceOf(BlertError);
    expect((await store.loadRules())[0]!.enabled).toBe(true);
  });

  it('AC-07 출처별 삭제는 해당 프리셋 규칙만 지운다', async () => {
    const store = new Store(dir);
    await store.addRules([draft('BTCUSDT', 'preset:major-swing'), draft('ETHUSDT', 'preset:major-swing'), draft('SOLUSDT')]);
    expect(await store.deleteBySource('preset:major-swing')).toEqual([1, 2]);
    expect((await store.loadRules()).map((r) => r.symbol)).toEqual(['SOLUSDT']);
  });

  it('규칙이 바뀌면 rules.changed용 콜백에 ID 목록을 전달한다', async () => {
    const seen: number[][] = [];
    const store = new Store(dir, { onRulesChanged: (ids) => seen.push(ids) });
    await store.addRules([draft('BTCUSDT'), draft('ETHUSDT')]);
    await store.setEnabled('all', false);
    expect(seen).toEqual([[1, 2], [1, 2]]);
  });

  it('상태는 규칙과 다른 파일에 저장된다', async () => {
    const store = new Store(dir);
    await store.addRules([draft('BTCUSDT')]);
    await store.saveStates([{ ruleId: 1, armed: false, lastFiredAt: 'x' }]);
    expect(await store.loadStates()).toEqual([{ ruleId: 1, armed: false, lastFiredAt: 'x' }]);
    expect(await readFile(join(dir, 'rules.json'), 'utf8')).not.toContain('lastFiredAt');
  });

  it('동시에 규칙을 추가해도 ID가 겹치거나 유실되지 않는다 (잠금)', async () => {
    const stores = [new Store(dir), new Store(dir), new Store(dir)];
    await Promise.all(stores.flatMap((s, i) => [s.addRules([draft(`A${i}USDT`)]), s.addRules([draft(`B${i}USDT`)])]));
    const rules = await new Store(dir).loadRules();
    expect(rules.map((r) => r.id).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('쓰기 후 임시 파일이 남지 않는다 (원자적 쓰기)', async () => {
    const store = new Store(dir);
    await store.addRules([draft('BTCUSDT')]);
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(files).not.toContain('.lock');
  });

  it('깨진 JSON은 파일명과 해결 방법을 담은 오류를 낸다', async () => {
    await writeFile(join(dir, 'rules.json'), '{ nope');
    await expect(new Store(dir).loadRules()).rejects.toMatchObject({ messageKey: 'store.corrupt', exitCode: 9 });
  });
});

describe('store 잠금', () => {
  it('죽은 프로세스가 남긴 잠금은 회수한다', async () => {
    const lock = join(dir, '.lock');
    await writeFile(lock, '2147483646'); // 존재하지 않는 PID
    await expect(withLock(lock, async () => 'ok')).resolves.toBe('ok');
  });

  it('살아 있는 프로세스가 잡은 잠금은 기다리다가 시간 초과 오류를 낸다', async () => {
    const lock = join(dir, '.lock');
    await writeFile(lock, String(process.pid));
    await expect(withLock(lock, async () => 1, { timeoutMs: 100, retryMs: 10 })).rejects.toMatchObject({
      messageKey: 'store.lockTimeout',
    });
  });
});

describe('store 마이그레이션', () => {
  interface V2 { schemaVersion: number; items: string[] }
  const spec = (path: string): FileSpec<V2> => ({
    path,
    name: 'x.json',
    current: 2,
    steps: [(d) => ({ ...d, items: [String(d.item)] })],
    defaults: () => ({ schemaVersion: 2, items: [] }),
  });

  it('schemaVersion이 낮으면 변환하고 원본을 .bak으로 보관한다', async () => {
    const path = join(dir, 'x.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 1, item: 'a' }));
    const v = await readJson(spec(path));
    expect(v).toMatchObject({ schemaVersion: 2, items: ['a'] });
    expect(JSON.parse(await readFile(`${path}.bak`, 'utf8')).schemaVersion).toBe(1);
    expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(2);
  });

  it('schemaVersion이 더 높으면 업데이트 안내 오류를 낸다', async () => {
    const path = join(dir, 'x.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 3 }));
    await expect(readJson(spec(path))).rejects.toMatchObject({ messageKey: 'store.schemaTooNew' });
  });
});
