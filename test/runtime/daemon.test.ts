import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, type ProcessLike, type RuntimeOptions } from '../../src/runtime/index.js';
import { createNotifier } from '../../src/notify/index.js';
import { Store } from '../../src/store/index.js';
import { FakeClock } from '../../src/shared/clock.js';
import type { Rule } from '../../src/shared/types.js';
import { FakeNetwork, miniTicker } from '../binance/fakeNetwork.js';

const T0 = Date.UTC(2026, 10, 1, 5, 0, 0);

class FakeProcess implements ProcessLike {
  handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  on(event: string, h: (...a: unknown[]) => void) {
    (this.handlers.get(event) ?? this.handlers.set(event, new Set()).get(event)!).add(h);
  }
  off(event: string, h: (...a: unknown[]) => void) {
    this.handlers.get(event)?.delete(h);
  }
}

type Draft = Omit<Rule, 'id' | 'createdAt'>;
const price = (symbol: string, target: number, market: Draft['market'] = 'spot'): Draft => ({
  type: 'price', market, symbol, condition: { type: 'price', direction: 'above', price: target }, repeat: { kind: 'once' }, source: 'manual', enabled: true,
});

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let runtimes: Runtime[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blert-dmn-'));
});
afterEach(async () => {
  for (const r of runtimes) await r.stop().catch(() => {});
  runtimes = [];
  await rm(dir, { recursive: true, force: true });
});

/** 데몬(mode daemon)과, 같은 설정 폴더를 쓰는 별도 CLI 저장소(다른 터미널의 blert add)를 만든다 */
async function setup(drafts: Draft[], extra: Partial<RuntimeOptions> = {}) {
  const store = new Store(dir);
  if (drafts.length) await store.addRules(drafts);
  await store.updateConfig((c) => {
    c.disclaimerAccepted = true;
  });
  const net = new FakeNetwork();
  const clock = new FakeClock(T0);
  const out: string[] = [];
  const consoleLines: string[] = [];
  const toasts: string[] = [];
  const modes: string[] = [];
  const rt = new Runtime({
    dir,
    io: { out: (t) => void out.push(t), err: (t) => void out.push(t) },
    makeNotifier: (logger, mode) => {
      modes.push(mode);
      return createNotifier({
        out: (l) => consoleLines.push(l),
        console: mode !== 'daemon', // 데몬은 console 어댑터를 쓰지 않는다 (D-55)
        soundEnabled: () => false,
        clock,
        logger,
        platform: 'linux',
        run: async (cmd, args) => void toasts.push(`${cmd} ${args.join(' ')}`),
      });
    },
    clock,
    process: new FakeProcess(),
    mode: 'daemon',
    timing: { startupTimeoutMs: 300, sleepCheckMs: 20, silenceMs: 60_000, statusMs: 50, stopPollMs: 20, rulesPollMs: 40, rulesDebounceMs: 10, ...extra.timing },
    feedOptions: { wsFactory: net.factory, fetchFn: (async () => { throw new Error('unexpected fetch'); }) as unknown as typeof fetch, sleep: async () => {} },
    ...extra,
  });
  runtimes.push(rt);
  const logText = async () => {
    const files = await readdir(join(dir, 'logs')).catch(() => []);
    return (await Promise.all(files.map((f) => readFile(join(dir, 'logs', f), 'utf8')))).join('\n');
  };
  const other = new Store(dir); // 다른 터미널의 CLI
  return { rt, store, other, net, clock, out, consoleLines, toasts, modes, logText };
}

describe('runtime 데몬 실행 (FR-RUN-03, D-54~D-58)', () => {
  it('AC-42 데몬은 감시 시작 알림을 내고, PID 파일(mode daemon)과 준비 완료 상태 파일을 만든다', async () => {
    const h = await setup([price('BTCUSDT', 70000), price('BTCUSDT', 80000, 'futures')]);
    const done = h.rt.runDaemon();
    await waitFor(async () => (await h.store.readStatus())?.state === 'ready');
    const lock = await h.store.readRunLock();
    expect(lock).toMatchObject({ pid: process.pid, mode: 'daemon' });
    const status = await h.store.readStatus();
    expect(status).toMatchObject({ pid: process.pid, state: 'ready', rules: { spot: 1, futures: 1 } });
    expect(status!.connections.map((c) => c.stream).sort()).toEqual(['futures', 'spot']);
    expect(await h.logText()).toContain('감시 시작'); // 알림 전체가 로그에 남는다 (D-55)
    await h.store.requestStop(T0);
    expect(await done).toBe(0);
  });

  it('D-55 데몬은 console 어댑터와 화면 출력 없이 desktop 알림을 쓴다', async () => {
    const h = await setup([price('BTCUSDT', 70000)]);
    expect(h.modes).toEqual(['daemon']);
    const done = h.rt.runDaemon();
    await waitFor(() => h.toasts.length > 0); // 감시 시작 알림이 desktop 어댑터로 나간다
    expect(h.consoleLines).toEqual([]);
    await h.store.requestStop(T0);
    await done;
  });

  it('AC-44 종료 요청 파일(blert.stop)을 두면 상태를 저장하고 정상 종료하며, PID·상태·요청 파일을 모두 지운다', async () => {
    const h = await setup([price('BTCUSDT', 70000)]);
    const done = h.rt.runDaemon();
    await waitFor(async () => (await h.store.readStatus())?.state === 'ready');
    h.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 69_000));
    await h.store.requestStop(T0);
    expect(await done).toBe(0);
    expect(await h.store.readRunLock()).toBeUndefined();
    expect(await h.store.readStatus()).toBeUndefined();
    expect(await h.store.stopRequested()).toBe(false);
    expect(await h.logText()).toContain('stopped (exit 0)');
  });

  it('AC-44 시작 전에 남아 있던 종료 요청은 무시한다', async () => {
    const h = await setup([price('BTCUSDT', 70000)]);
    await h.store.requestStop(T0 - 1000); // 이전 실행이 남긴 요청
    const done = h.rt.runDaemon();
    await waitFor(async () => (await h.store.readStatus())?.state === 'ready');
    await sleep(100);
    expect(await h.store.readRunLock()).toMatchObject({ mode: 'daemon' }); // 아직 실행 중
    await h.store.requestStop(T0);
    await done;
  });

  it('AC-43 상태 파일은 주기적으로 갱신되고 연결 상태와 최근 감시 중단 구간을 담는다', async () => {
    const h = await setup([price('BTCUSDT', 70000)]);
    const done = h.rt.runDaemon();
    await waitFor(async () => (await h.store.readStatus())?.state === 'ready');
    const first = (await h.store.readStatus())!.updatedAt;
    h.clock.advance(60_000); // 절전 복귀처럼 시계가 건너뜀 → 중단 구간 기록
    await waitFor(async () => (await h.store.readStatus())?.lastGap?.reason === 'sleep');
    expect((await h.store.readStatus())!.updatedAt >= first).toBe(true);
    await h.store.requestStop(T0);
    await done;
  });

  it('AC-45 데몬이 이미 실행 중이면 새 데몬·포그라운드 실행을 거부하고 status를 안내한다 (실행 중인 데몬의 상태는 건드리지 않는다)', async () => {
    const h = await setup([price('BTCUSDT', 70000)]);
    const done = h.rt.runDaemon();
    await waitFor(async () => (await h.store.readStatus())?.state === 'ready');

    const second = new Runtime({ dir, io: { out() {}, err() {} }, makeNotifier: (l) => createNotifier({ out() {}, soundEnabled: () => false, logger: l, platform: 'linux', run: async () => {} }), mode: 'daemon', clock: h.clock, process: new FakeProcess(), timing: { startupTimeoutMs: 300 }, feedOptions: { wsFactory: new FakeNetwork().factory } });
    runtimes.push(second);
    expect(await second.runDaemon()).toBe(1);
    expect((await h.store.readStatus())?.state).toBe('ready'); // 실패 상태로 덮어쓰지 않았다

    const fg = new Runtime({ dir, io: { out() {}, err() {} }, makeNotifier: (l) => createNotifier({ out() {}, soundEnabled: () => false, logger: l, platform: 'linux', run: async () => {} }), clock: h.clock, process: new FakeProcess(), timing: { startupTimeoutMs: 300 }, feedOptions: { wsFactory: new FakeNetwork().factory } });
    runtimes.push(fg);
    await expect(fg.start()).rejects.toMatchObject({ messageKey: 'err.runAlreadyDaemon', params: { pid: process.pid } });
    await h.store.requestStop(T0);
    await done;
  });

  it('AC-49 고지 미동의·활성 규칙 없음은 실패 이유와 종료 코드를 상태 파일에 남기고 데몬이 남지 않는다', async () => {
    const noRules = await setup([]);
    expect(await noRules.rt.runDaemon()).toBe(1);
    expect((await noRules.store.readStatus())).toMatchObject({ state: 'failed', failure: { messageKey: 'err.runNoRules', exitCode: 1 } });
    expect(await noRules.store.readRunLock()).toBeUndefined();
  });

  it('AC-49 필요한 시장에 연결할 수 없으면 종료 코드 3과 연결 실패 이유를 상태 파일에 남긴다', async () => {
    const h = await setup([price('BTCUSDT', 70000)]);
    h.net.refuse = true;
    expect(await h.rt.runDaemon()).toBe(3);
    expect(await h.store.readStatus()).toMatchObject({ state: 'failed', failure: { messageKey: 'err.startConnect', exitCode: 3, params: { streams: 'spot' } } });
    expect(await h.store.readRunLock()).toBeUndefined();
  });

  it('AC-49 고지에 동의하지 않았으면 종료 코드 1과 init 안내 문구 키를 남긴다', async () => {
    const h = await setup([price('BTCUSDT', 70000)]);
    await h.store.updateConfig((c) => {
      c.disclaimerAccepted = false;
    });
    expect(await h.rt.runDaemon()).toBe(1);
    expect((await h.store.readStatus())?.failure).toMatchObject({ messageKey: 'err.runNeedInit', exitCode: 1 });
  });
});

describe('runtime 서비스(자동 시작) 모드 (D-67)', () => {
  it('AC-57 서비스로 시작했을 때 네트워크가 없어도 종료하지 않고 감시 못 하는 규칙을 알린 뒤 계속 재시도하고, 연결되면 복구를 알린다', async () => {
    const h = await setup([price('BTCUSDT', 70000)], { service: true });
    h.net.refuse = true; // 로그인 직후 네트워크가 아직 없는 상황
    const done = h.rt.runDaemon();
    await waitFor(async () => (await h.store.readStatus())?.state === 'ready'); // 시작에 실패하지 않고 준비 완료 상태가 된다
    expect(await h.store.readRunLock()).toMatchObject({ mode: 'daemon' });
    await waitFor(async () => (await h.logText()).includes('현물 연결 실패'));
    expect(await h.logText()).toContain('알림 1개를 지금은 감시하지 못합니다');
    expect((await h.store.readStatus())?.failure).toBeUndefined();

    h.net.refuse = false; // 네트워크가 붙는다
    await waitFor(async () => (await h.logText()).includes('현물 연결 복구'), 8000);
    expect(await h.logText()).toContain('알림 감시를 다시 시작했습니다');
    h.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 69_000));
    h.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 70_010));
    await waitFor(async () => (await h.logText()).includes('BTC 70,000 돌파')); // 복구 뒤 감시가 실제로 동작한다
    await h.store.requestStop(T0);
    expect(await done).toBe(0);
  }, 20000);

  it('AC-57 서비스가 아니면(사용자가 직접 start) 같은 상황에서 시작 실패로 알리고 종료 코드 3으로 끝난다', async () => {
    const h = await setup([price('BTCUSDT', 70000)]);
    h.net.refuse = true;
    expect(await h.rt.runDaemon()).toBe(3);
    expect((await h.store.readStatus())?.failure?.exitCode).toBe(3);
  });
});

describe('runtime 규칙 변경 반영 (D-56)', () => {
  it('AC-46 데몬 실행 중 다른 터미널이 규칙을 추가하면 재시작 없이 새 규칙이 반영된다', async () => {
    const h = await setup([price('BTCUSDT', 70000)]);
    const done = h.rt.runDaemon();
    await waitFor(async () => (await h.store.readStatus())?.state === 'ready');
    expect((await h.store.readStatus())!.rules.spot).toBe(1);

    await h.other.addRules([price('ETHUSDT', 4000)]); // 다른 터미널의 blert add
    await waitFor(() => h.net.live.some((s) => s.subscribed.has('ethusdt@miniTicker'))); // 새 심볼을 구독한다
    await waitFor(async () => (await h.store.readStatus())?.rules.spot === 2);

    h.net.push('ethusdt@miniTicker', miniTicker('ETHUSDT', 3_900));
    h.net.push('ethusdt@miniTicker', miniTicker('ETHUSDT', 4_010));
    await waitFor(() => h.toasts.length >= 2); // 시작 알림 + ETH 돌파 알림
    expect(await h.logText()).toContain('ETH 4,000 돌파');
    await h.store.requestStop(T0);
    await done;
  });

  it('AC-46 다른 터미널이 규칙을 일시정지하거나 삭제하면 그 심볼 구독을 끊는다', async () => {
    const h = await setup([price('BTCUSDT', 70000), price('ETHUSDT', 4000)]);
    const done = h.rt.runDaemon();
    await waitFor(async () => (await h.store.readStatus())?.state === 'ready');
    expect(h.net.live.some((s) => s.subscribed.has('ethusdt@miniTicker'))).toBe(true);
    await h.other.deleteRules(2);
    await waitFor(() => !h.net.live.some((s) => s.subscribed.has('ethusdt@miniTicker')));
    expect(h.net.live.some((s) => s.subscribed.has('btcusdt@miniTicker'))).toBe(true);
    await h.store.requestStop(T0);
    await done;
  });

  it('AC-46 포그라운드 run도 다른 터미널의 규칙 변경을 반영한다', async () => {
    const h = await setup([price('BTCUSDT', 70000)], { mode: 'foreground' });
    const done = h.rt.runForeground();
    await waitFor(() => h.consoleLines.some((l) => l.includes('감시 시작')));
    await h.other.addRules([price('SOLUSDT', 200)]);
    await waitFor(() => h.net.live.some((s) => s.subscribed.has('solusdt@miniTicker')));
    await h.rt.stop();
    expect(await done).toBe(0);
  });
});

describe('runtime 데몬 키 흔적 (NFR-SEC-01)', () => {
  it('AC-50 상태 파일·PID 파일·로그에 키 형태 문자열이 없다', async () => {
    const h = await setup([price('BTCUSDT', 70000)]);
    const done = h.rt.runDaemon();
    await waitFor(async () => (await h.store.readStatus())?.state === 'ready');
    const files = await Promise.all(['blert.status.json', 'blert.pid'].map((f) => readFile(join(dir, f), 'utf8')));
    await h.store.requestStop(T0);
    await done;
    const text = `${files.join('\n')}\n${await h.logText()}`;
    expect(text).not.toMatch(/[A-Za-z0-9]{64}/);
    expect(text).not.toContain('PRIVATE KEY');
  });
});
