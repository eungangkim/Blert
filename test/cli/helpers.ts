import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type Deps, type NotifierPort, type PresetService, type Runner } from '../../src/cli/index.js';
import { createPresetService } from '../../src/presets/index.js';
import { Store } from '../../src/store/index.js';

export interface Harness {
  deps: Deps;
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
export async function makeHarness(answers: string[] = [], presets: PresetService | 'real' = fakePresets()): Promise<Harness> {
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
  };
  const deps: Deps = {
    store,
    notifier,
    runner,
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
    deps,
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
