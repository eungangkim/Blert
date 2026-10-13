import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../../src/shared/clock.js';
import { HISTORY_MAX_AGE_MS, HISTORY_MAX_ENTRIES, pruneHistory, toHistoryEntry, type HistoryEntry } from '../../src/shared/history.js';
import { HistoryRecorder, Store } from '../../src/store/index.js';
import type { Alert } from '../../src/shared/types.js';

const T0 = Date.UTC(2026, 9, 20, 0, 0, 0);
const DAY = 24 * 3_600_000;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blert-history-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (ts: number, ruleId = 1, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  ts: new Date(ts).toISOString(),
  ruleId,
  kind: 'up',
  titleKey: 'alert.price.above.title',
  params: { coin: 'BTC', price: '70,012' },
  ...over,
});
const store = (clock = new FakeClock(T0)) => new Store(dir, { clock });

describe('알림 기록 저장 (FR-HIST-01, D-143, D-144)', () => {
  it('AC-127 기록은 history.json에 schemaVersion과 함께 저장되고 오래된 순으로 읽힌다', async () => {
    const s = store();
    await s.appendHistory([entry(T0 - 2000, 1), entry(T0 - 1000, 2, { quiet: 'sound' })]);
    await s.appendHistory([entry(T0, 3, { kind: 'warn' })]);
    const file = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8'));
    expect(file.schemaVersion).toBe(1);
    expect(file.entries).toHaveLength(3);
    const r = await s.loadHistory();
    expect(r.corrupt).toBe(false);
    expect(r.entries.map((e) => [e.ruleId, e.quiet])).toEqual([[1, undefined], [2, 'sound'], [3, undefined]]);
  });

  it('AC-127 쓰기는 임시 파일을 교체하는 방식이라 .tmp 파일이 남지 않는다', async () => {
    const s = store();
    for (let i = 0; i < 5; i++) await s.appendHistory([entry(T0 + i, i)]);
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('AC-127 30일이 지난 기록은 다음 쓰기 때 지운다', async () => {
    const clock = new FakeClock(T0);
    const s = store(clock);
    await s.appendHistory([entry(T0 - 31 * DAY, 1), entry(T0 - 29 * DAY, 2)]);
    expect((await s.loadHistory()).entries.map((e) => e.ruleId)).toEqual([2]);
    clock.advance(2 * DAY); // 이제 2번도 31일 전
    await s.appendHistory([entry(clock.now(), 3)]);
    expect((await s.loadHistory()).entries.map((e) => e.ruleId)).toEqual([3]);
  });

  it('AC-127 2,000건을 넘으면 오래된 것부터 지우고 최신 2,000건만 남긴다', async () => {
    const s = store();
    const many = Array.from({ length: HISTORY_MAX_ENTRIES + 25 }, (_, i) => entry(T0 - 1000 + i, i + 1));
    await s.appendHistory(many);
    const r = (await s.loadHistory()).entries;
    expect(r).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(r[0]!.ruleId).toBe(26);
    expect(r.at(-1)!.ruleId).toBe(HISTORY_MAX_ENTRIES + 25);
    expect(HISTORY_MAX_AGE_MS).toBe(30 * DAY);
  });

  it('AC-127 pruneHistory는 정확히 30일 된 기록은 남기고 그보다 오래된 것은 지운다', () => {
    const e = [entry(T0 - 30 * DAY - 1, 1), entry(T0 - 30 * DAY, 2), entry(T0, 3)];
    expect(pruneHistory(e, T0).map((x) => x.ruleId)).toEqual([2, 3]);
    expect(pruneHistory(e, T0, { maxEntries: 1 }).map((x) => x.ruleId)).toEqual([3]);
  });

  it('AC-127 손상된 파일은 읽기에서는 비어 있다고 알리고, 쓸 때 .bak으로 옮겨 두고 새로 시작한다', async () => {
    const s = store();
    await writeFile(join(dir, 'history.json'), '{ not json');
    const r = await s.loadHistory();
    expect(r).toEqual({ entries: [], corrupt: true });
    expect(await readFile(join(dir, 'history.json'), 'utf8')).toBe('{ not json'); // 읽기는 파일을 건드리지 않는다
    await s.appendHistory([entry(T0, 1)]);
    expect(await readFile(join(dir, 'history.json.bak'), 'utf8')).toBe('{ not json');
    expect((await s.loadHistory()).entries).toHaveLength(1);
  });

  it('AC-127 더 새로운 schemaVersion이나 엉뚱한 형식도 손상으로 보고 원본을 .bak으로 보관한다', async () => {
    const s = store();
    for (const bad of [JSON.stringify({ schemaVersion: 99, entries: [] }), JSON.stringify({ schemaVersion: 1 }), '[]', 'null', '']) {
      await writeFile(join(dir, 'history.json'), bad);
      expect((await s.loadHistory()).corrupt, bad).toBe(true);
    }
    await writeFile(join(dir, 'history.json'), JSON.stringify({ schemaVersion: 99, entries: [] }));
    await s.appendHistory([entry(T0, 1)]);
    expect(JSON.parse(await readFile(join(dir, 'history.json.bak'), 'utf8')).schemaVersion).toBe(99);
  });

  it('AC-127 항목 하나가 이상하면 그 항목만 버리고 나머지는 읽는다', async () => {
    const s = store();
    const good = entry(T0, 7);
    await writeFile(
      join(dir, 'history.json'),
      JSON.stringify({ schemaVersion: 1, entries: [good, { ts: 'nope' }, null, 5, { ...good, kind: 'loud' }, { ...good, ruleId: 1.5 }, { ...good, params: { a: { b: 1 } , c: 'ok', d: 3 } }] }),
    );
    const r = await s.loadHistory();
    expect(r.corrupt).toBe(false);
    expect(r.entries.map((e) => e.ruleId)).toEqual([7, 7]);
    expect(r.entries[1]!.params).toEqual({ c: 'ok', d: 3 }); // 중첩 값은 버리고 문자열·숫자만 받아들인다
  });

  it('AC-128 기록이 켜져 있는지는 설정에서 읽고 없으면 켜짐이다', async () => {
    const s = store();
    expect(await s.historyEnabled()).toBe(true);
    await s.updateConfig((c) => {
      c.history = { enabled: false };
    });
    expect(await s.historyEnabled()).toBe(false);
    await s.updateConfig((c) => {
      c.history = { enabled: true };
    });
    expect(await s.historyEnabled()).toBe(true);
  });

  it('AC-128 clearHistory는 기록 파일을 지우고 지운 개수를 돌려준다', async () => {
    const s = store();
    expect(await s.clearHistory()).toBe(0);
    await s.appendHistory([entry(T0, 1), entry(T0, 2)]);
    expect(await s.clearHistory()).toBe(2);
    expect((await s.loadHistory()).entries).toEqual([]);
    expect((await readdir(dir)).includes('history.json')).toBe(false);
  });

  it('AC-129 알림에서 만든 기록 항목은 알림의 값만 담고, 비밀 값이 들어갈 자리가 없다', () => {
    const alert: Alert = { ruleId: 4, kind: 'account', titleKey: 'alert.fill.title', params: { coin: 'BTC', qty: '0.015' }, firedAt: new Date(T0).toISOString(), sound: 'off' };
    const e = toHistoryEntry(alert, 'all');
    expect(Object.keys(e).sort()).toEqual(['kind', 'params', 'quiet', 'ruleId', 'titleKey', 'ts']);
    expect(e.params).not.toBe(alert.params); // 복사본이라 나중에 알림이 바뀌어도 기록은 그대로다
  });
});

describe('기록 모으기 (D-143)', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const recorder = (o: { enabled?: () => Promise<boolean>; fail?: boolean } = {}) => {
    const written: HistoryEntry[][] = [];
    const errors: unknown[] = [];
    const r = new HistoryRecorder({
      append: async (e) => {
        if (o.fail) throw new Error('disk full');
        written.push(e);
      },
      enabled: o.enabled ?? (async () => true),
      onError: (e) => errors.push(e),
    });
    return { r, written, errors };
  };

  it('AC-124 한 번에 여러 건이 오면 1초 동안 모아서 한 번에 쓴다', async () => {
    const { r, written } = recorder();
    r.add([entry(T0, 1)]);
    await vi.advanceTimersByTimeAsync(400);
    r.add([entry(T0, 2), entry(T0, 3)]);
    expect(written).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(700);
    expect(written).toHaveLength(1);
    expect(written[0]!.map((e) => e.ruleId)).toEqual([1, 2, 3]);
  });

  it('AC-124 flush는 모인 것을 바로 쓰고 끝나기를 기다린다 (종료할 때)', async () => {
    const { r, written } = recorder();
    r.add([entry(T0, 1)]);
    await r.flush();
    expect(written).toHaveLength(1);
    await r.flush(); // 비어 있으면 아무것도 쓰지 않는다
    expect(written).toHaveLength(1);
  });

  it('AC-128 기록이 꺼져 있으면 모은 것을 버리고 쓰지 않는다', async () => {
    let on = true;
    const { r, written } = recorder({ enabled: async () => on });
    r.add([entry(T0, 1)]);
    on = false; // 모으는 동안 history off
    await r.flush();
    expect(written).toHaveLength(0);
    on = true;
    r.add([entry(T0, 2)]);
    await r.flush();
    expect(written.flat().map((e) => e.ruleId)).toEqual([2]);
  });

  it('AC-124 쓰기에 실패해도 던지지 않고 알려만 준다. 다음 묶음은 정상으로 쓴다', async () => {
    const { r, errors } = recorder({ fail: true });
    r.add([entry(T0, 1)]);
    await expect(r.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
