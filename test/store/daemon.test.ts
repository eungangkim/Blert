import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type StatusFile } from '../../src/store/index.js';
import { writePidFile } from '../../src/store/pid.js';
import { iso } from '../../src/shared/clock.js';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const DEAD_PID = 2_147_483_646;
const draft = { type: 'price' as const, market: 'spot' as const, symbol: 'BTCUSDT', condition: { type: 'price' as const, direction: 'above' as const, price: 1 }, repeat: { kind: 'once' as const }, source: 'manual' as const, enabled: true };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await sleep(10);
  }
}

let dir: string;
let store: Store;
let stops: (() => void)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blert-daemon-'));
  store = new Store(dir);
});
afterEach(async () => {
  for (const s of stops) s();
  stops = [];
  await rm(dir, { recursive: true, force: true });
});
const watch = (fn: () => void, o = { pollMs: 40, debounceMs: 10 }) => {
  const stop = store.watchRules(fn, o);
  stops.push(stop);
  return stop;
};

describe('store 규칙 파일 감시 (D-56)', () => {
  it('AC-46 다른 프로세스가 rules.json을 바꾸면(add) 변경을 알린다', async () => {
    let n = 0;
    watch(() => n++);
    const other = new Store(dir); // 다른 터미널의 blert add를 흉내 낸다
    await other.addRules([draft]);
    await waitFor(() => n >= 1);
    await other.setEnabled('all', false); // 일시정지
    await waitFor(() => n >= 2);
    await other.deleteRules('all');
    await waitFor(() => n >= 3);
  });

  it('AC-46 변경이 없으면 알리지 않고, 연달아 바꿔도 모아서 처리한다', async () => {
    let n = 0;
    watch(() => n++);
    await sleep(150);
    expect(n).toBe(0);
    const other = new Store(dir);
    await other.addRules([draft, draft, draft]);
    await sleep(200);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(2);
  });

  it('AC-46 파일 변경 이벤트를 놓쳐도 주기 확인이 변경을 찾아낸다', async () => {
    let n = 0;
    // 디바운스를 매우 길게 해 이벤트 경로를 사실상 막고, 주기 확인만으로 감지되는지 본다
    watch(() => n++, { pollMs: 40, debounceMs: 60_000 });
    await new Store(dir).addRules([draft]);
    await waitFor(() => n >= 1);
  });

  it('AC-46 설정 폴더가 아직 없어도 감시를 시작할 수 있고, 해제하면 더 알리지 않는다', async () => {
    const fresh = new Store(join(dir, 'not-yet'));
    let n = 0;
    const stop = fresh.watchRules(() => n++, { pollMs: 30, debounceMs: 5 });
    stops.push(stop);
    await fresh.addRules([draft]);
    await waitFor(() => n >= 1);
    stop();
    const seen = n;
    await fresh.addRules([draft]);
    await sleep(150);
    expect(n).toBe(seen);
  });

  it('AC-46 rules.json이 아닌 파일(state.json 등)이 바뀌어도 알리지 않는다', async () => {
    let n = 0;
    watch(() => n++);
    await store.saveStates([{ ruleId: 1, armed: true }]);
    await writeFile(join(dir, 'other.txt'), 'x');
    await sleep(200);
    expect(n).toBe(0);
  });
});

describe('store 데몬 상태 파일 (blert.status.json, D-58·D-59)', () => {
  const status = (over: Partial<StatusFile> = {}): Omit<StatusFile, 'schemaVersion'> => ({
    pid: 4242, state: 'ready', startedAt: iso(NOW), updatedAt: iso(NOW), rules: { spot: 2, futures: 1 },
    connections: [{ stream: 'spot', state: 'open' }, { stream: 'futures-account', state: 'open' }], ...over,
  });

  it('AC-43 상태를 쓰고 읽는다. 최상단은 schemaVersion이고 키 형태 값은 없다', async () => {
    await store.writeStatus(status({ lastGap: { from: iso(NOW - 60_000), to: iso(NOW), reason: 'sleep' } }));
    const raw = JSON.parse(await readFile(join(dir, 'blert.status.json'), 'utf8'));
    expect(Object.keys(raw)[0]).toBe('schemaVersion');
    expect(await store.readStatus()).toMatchObject({ pid: 4242, state: 'ready', rules: { spot: 2, futures: 1 }, lastGap: { reason: 'sleep' } });
  });

  it('AC-49 시작 실패는 오류 문구 키와 종료 코드로 남는다', async () => {
    await store.writeStatus(status({ state: 'failed', failure: { messageKey: 'err.startConnect', params: { streams: 'spot' }, exitCode: 3 } }));
    expect((await store.readStatus())?.failure).toEqual({ messageKey: 'err.startConnect', params: { streams: 'spot' }, exitCode: 3 });
  });

  it('AC-43 같은 상태 파일에 동시에 여러 번 써도 모두 성공하고 파일은 항상 완전한 JSON이다 (Windows의 교체 충돌 대비)', async () => {
    const writes = Array.from({ length: 30 }, (_, i) => store.writeStatus(status({ updatedAt: iso(NOW + i) })));
    const reads = Array.from({ length: 30 }, () => store.readStatus());
    await expect(Promise.all(writes)).resolves.toHaveLength(30);
    for (const r of await Promise.all(reads)) if (r) expect(r.state).toBe('ready');
    expect((await store.readStatus())?.state).toBe('ready');
  });

  it('상태 파일이 없거나 깨졌으면 상태 없음으로 본다', async () => {
    expect(await store.readStatus()).toBeUndefined();
    await writeFile(join(dir, 'blert.status.json'), '{ broken');
    expect(await store.readStatus()).toBeUndefined();
  });

  it('clearStatus는 내 PID의 상태만 지운다', async () => {
    await store.writeStatus(status({ pid: 4242 }));
    await store.clearStatus(1);
    expect(await store.readStatus()).toBeDefined();
    await store.clearStatus(4242);
    expect(await store.readStatus()).toBeUndefined();
  });
});

describe('store 데몬 종료 요청 (blert.stop, D-57)', () => {
  it('AC-44 요청 파일을 만들고, 확인하고, 지울 수 있다', async () => {
    expect(await store.stopRequested()).toBe(false);
    await store.requestStop(NOW);
    expect(await store.stopRequested()).toBe(true);
    expect(JSON.parse(await readFile(join(dir, 'blert.stop'), 'utf8'))).toMatchObject({ schemaVersion: 1, requestedAt: iso(NOW) });
    await store.clearStopRequest();
    expect(await store.stopRequested()).toBe(false);
    await store.clearStopRequest(); // 없어도 오류 없음
  });
});

describe('store 실행 잠금 점검과 실행 모드 (D-61)', () => {
  it('AC-48 파일이 없으면 none, 살아 있고 최근이면 running, 주인이 없으면 stale이다', async () => {
    expect(await store.inspectRunLock(NOW, 60_000)).toEqual({ state: 'none' });
    await store.acquireRunLock({ pid: process.pid, now: NOW, staleMs: 60_000, mode: 'daemon' });
    expect(await store.inspectRunLock(NOW + 10_000, 60_000)).toMatchObject({ state: 'running', file: { pid: process.pid, mode: 'daemon' } });
    expect(await store.inspectRunLock(NOW + 5 * 60_000, 60_000)).toMatchObject({ state: 'stale' }); // 생존 신호가 끊김
    await writePidFile(join(dir, 'blert.pid'), { schemaVersion: 1, pid: DEAD_PID, startedAt: iso(NOW), heartbeatAt: iso(NOW) });
    expect(await store.inspectRunLock(NOW, 60_000)).toMatchObject({ state: 'stale', file: { pid: DEAD_PID } });
  });

  it('점검은 파일을 바꾸거나 지우지 않는다', async () => {
    await writePidFile(join(dir, 'blert.pid'), { schemaVersion: 1, pid: DEAD_PID, startedAt: iso(NOW), heartbeatAt: iso(NOW) });
    await store.inspectRunLock(NOW, 60_000);
    expect(await store.readRunLock()).toMatchObject({ pid: DEAD_PID });
  });

  it('모드를 지정하지 않으면 포그라운드로 기록하고, 모드가 없는 옛 파일은 모드 없이 읽는다', async () => {
    await store.acquireRunLock({ pid: process.pid, now: NOW, staleMs: 60_000 });
    expect((await store.readRunLock())?.mode).toBe('foreground');
    await writeFile(join(dir, 'blert.pid'), JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt: iso(NOW), heartbeatAt: iso(NOW) }));
    expect((await store.readRunLock())?.mode).toBeUndefined();
  });
});
