import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/index.js';
import { writePidFile } from '../../src/store/pid.js';
import { iso } from '../../src/shared/clock.js';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const MIN = 60_000;
const DEAD_PID = 2_147_483_646;

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blert-pid-'));
  store = new Store(dir);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const acquire = (pid = process.pid, now = NOW) => store.acquireRunLock({ pid, now, staleMs: 60_000 });

describe('store 실행 잠금 (blert.pid)', () => {
  it('처음에는 잠금을 잡고 schemaVersion과 PID·시각을 기록한다', async () => {
    expect(await acquire()).toEqual({ ok: true, previous: undefined });
    const raw = JSON.parse(await readFile(join(dir, 'blert.pid'), 'utf8'));
    expect(Object.keys(raw)[0]).toBe('schemaVersion');
    expect(raw).toMatchObject({ pid: process.pid, startedAt: iso(NOW), heartbeatAt: iso(NOW) });
  });

  it('주인이 살아 있고 생존 신호가 최근이면 거부하고 주인 정보를 돌려준다', async () => {
    await acquire();
    const second = await acquire(process.pid, NOW + 30_000);
    expect(second).toMatchObject({ ok: false, holder: { pid: process.pid } });
  });

  it('주인이 죽었으면 이전 실행 기록을 돌려주며 가져온다 (비정상 종료)', async () => {
    await writePidFile(join(dir, 'blert.pid'), { schemaVersion: 1, pid: DEAD_PID, startedAt: iso(NOW - 30 * MIN), heartbeatAt: iso(NOW - 10 * MIN) });
    const r = await acquire();
    expect(r).toMatchObject({ ok: true, previous: { pid: DEAD_PID, heartbeatAt: iso(NOW - 10 * MIN) } });
    expect((await store.readRunLock())?.pid).toBe(process.pid);
  });

  it('프로세스가 있어도 생존 신호가 staleMs보다 오래 끊겼으면 낡은 것으로 본다', async () => {
    await acquire();
    const r = await acquire(process.pid, NOW + 61_000);
    expect(r.ok).toBe(true);
    expect(r.ok && r.previous?.pid).toBe(process.pid);
  });

  it('깨진 파일은 주인이 없는 것으로 보고 덮어쓴다', async () => {
    await writeFile(join(dir, 'blert.pid'), '{ not json');
    expect(await acquire()).toEqual({ ok: true, previous: undefined });
  });

  it('생존 신호 갱신은 내 잠금일 때만 하고, 해제도 내 잠금일 때만 한다', async () => {
    await acquire();
    await store.touchRunLock(process.pid, NOW + 15_000);
    expect((await store.readRunLock())?.heartbeatAt).toBe(iso(NOW + 15_000));

    await store.touchRunLock(DEAD_PID, NOW + 99_000); // 남의 신호는 무시
    expect((await store.readRunLock())?.heartbeatAt).toBe(iso(NOW + 15_000));
    await store.releaseRunLock(DEAD_PID);
    expect(await store.readRunLock()).toBeDefined();

    await store.releaseRunLock(process.pid);
    expect(await store.readRunLock()).toBeUndefined();
  });

  it('동시에 두 곳에서 잡으려 해도 한쪽만 성공한다', async () => {
    const results = await Promise.all([acquire(), new Store(dir).acquireRunLock({ pid: process.pid, now: NOW, staleMs: 60_000 })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});
