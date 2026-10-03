import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type DaemonPort, type Deps, type NotifierPort, type PresetService, type Runner } from '../../src/cli/index.js';
import { createPresetService } from '../../src/presets/index.js';
import { createKeyService } from '../../src/security/index.js';
import type { NetworkMode } from '../../src/shared/network.js';
import { FakeKeychain, jsonResponse, restrictions } from '../security/helpers.js';
import { Store } from '../../src/store/index.js';

/** 데몬 프로세스 대신 쓰는 가짜. 시계는 sleep할 때만 흐른다 (실제로 기다리지 않는다) */
export interface DaemonSim {
  nowMs: number;
  pid: number;
  launches: number;
  detached: boolean;
  kills: number[];
  /** launch 직후 호출된다 (데몬이 상태 파일을 쓰거나 끝나는 것을 흉내 낸다) */
  onLaunch?: () => void | Promise<void>;
  /** sleep할 때마다 호출된다 (시간이 흐르는 동안 데몬이 하는 일을 흉내 낸다) */
  onSleep?: () => void | Promise<void>;
  onKill?: (pid: number) => void | Promise<void>;
  /** launch한 자식을 종료 코드로 끝낸다 */
  finish?: (code: number) => void;
  /** logs -f를 끝내는 신호 */
  abort: AbortController;
  sleeps: number;
}

export interface Harness {
  /** 데몬 시뮬레이션 (v0.4) */
  sim: DaemonSim;
  deps: Deps;
  /** 설정 폴더(임시). 키 PEM 같은 입력 파일도 여기에 만든다 */
  dir: string;
  /** 가짜 키체인. 키가 어디에 저장됐는지 확인한다 */
  keychain: FakeKeychain;
  /** 권한 조회(/sapi) 응답을 바꾼다. 마지막 응답이 계속 쓰인다 */
  setFetch(...responses: (Response | Error)[]): void;
  /** 권한 조회 요청이 몇 번 나갔는지 */
  fetchCalls(): number;
  /** 가짜 notifier가 받은 호출 (예: 'test:up', 'soundTest:warn') */
  calls: string[];
  /** true로 바꾸면 다음 soundTest가 실패한다 */
  failSound: { value: boolean };
  /** 가짜 runner가 돌려줄 종료 코드 */
  runCode: { value: number };
  out: string[];
  err: string[];
  asked: string[];
  run(argv: string): Promise<number>;
  cleanup(): Promise<void>;
}

export const fakePresets = (installed: string[] = []): PresetService => ({
  list: async () => [{ slug: 'major-swing', nameKey: 'help.cmd.list.summary', ruleCount: 3, installed: installed.includes('major-swing') }],
  install: async (slug) => {
    installed.push(slug);
    return 3;
  },
  remove: async () => 3,
});

/**
 * answers: ask()가 차례로 돌려줄 입력. 다 쓰면 null(입력 끝).
 * presets에 'real'을 주면 실제 프리셋 서비스(임시 폴더의 store 사용)를 쓴다.
 */
export async function makeHarness(
  answers: string[] = [],
  presets: PresetService | 'real' = fakePresets(),
  network: NetworkMode = 'mainnet',
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'blert-cli-'));
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  const store = new Store(dir);
  const calls: string[] = [];
  const failSound = { value: false };
  const runCode = { value: 0 };
  const notifier: NotifierPort = {
    test: async (kind) => void calls.push(`test:${kind}`),
    soundTest: async (kind) => {
      calls.push(`soundTest:${kind}`);
      if (failSound.value) throw new Error('no audio device');
    },
  };
  const runner: Runner = {
    run: async ({ verbose }) => {
      calls.push(`run:${verbose}`);
      return runCode.value;
    },
    daemon: async ({ verbose }) => {
      calls.push(`daemon:${verbose}`);
      return runCode.value;
    },
  };
  const sim: DaemonSim = { nowMs: Date.UTC(2026, 10, 1, 12, 0, 0), pid: process.pid, launches: 0, detached: false, kills: [], abort: new AbortController(), sleeps: 0 };
  const daemon: DaemonPort = {
    launch: () => {
      sim.launches++;
      let resolve!: (code: number) => void;
      const exit = new Promise<number>((r) => (resolve = r));
      sim.finish = resolve;
      void sim.onLaunch?.();
      return { pid: sim.pid, exit, detach: () => void (sim.detached = true) };
    },
    kill: (pid) => {
      sim.kills.push(pid);
      void sim.onKill?.(pid);
    },
    now: () => sim.nowMs,
    sleep: async (ms) => {
      sim.sleeps++;
      sim.nowMs += ms;
      await sim.onSleep?.();
    },
  };
  const keychain = new FakeKeychain();
  let responses: (Response | Error)[] = [jsonResponse(restrictions())];
  let fetchCount = 0;
  const fetchFn = (async () => {
    const r = responses[Math.min(fetchCount++, responses.length - 1)]!;
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  const keys = createKeyService({ keychain, fetchFn, clock: { now: () => Date.UTC(2026, 9, 5, 12) }, mode: network });
  const deps: Deps = {
    store,
    notifier,
    runner,
    keys,
    network,
    daemon,
    interrupt: () => sim.abort.signal,
    presets: presets === 'real' ? createPresetService(store) : presets,
    io: {
      out: (t) => void out.push(t),
      err: (t) => void err.push(t),
      ask: async (q) => {
        asked.push(q);
        return queue.shift() ?? null;
      },
    },
  };
  return {
    sim,
    deps,
    dir,
    keychain,
    setFetch: (...r) => {
      responses = r;
      fetchCount = 0;
    },
    fetchCalls: () => fetchCount,
    calls,
    failSound,
    runCode,
    out,
    err,
    asked,
    run: (argv) => runCli(argv.split(' ').filter(Boolean), deps),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
