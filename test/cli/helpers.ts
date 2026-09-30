import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type Deps, type PresetService } from '../../src/cli/index.js';
import { Store } from '../../src/store/index.js';

export interface Harness {
  deps: Deps;
  out: string[];
  err: string[];
  asked: string[];
  run(argv: string): Promise<number>;
  cleanup(): Promise<void>;
}

export const fakePresets = (installed: string[] = []): PresetService => ({
  list: () => [{ slug: 'major-swing', nameKey: 'help.cmd.list.summary' }],
  install: async (slug) => {
    installed.push(slug);
    return 3;
  },
});

/** answers: ask()가 차례로 돌려줄 입력. 다 쓰면 null(입력 끝). */
export async function makeHarness(answers: string[] = [], presets: PresetService = fakePresets()): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'blert-cli-'));
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  const deps: Deps = {
    store: new Store(dir),
    presets,
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
    out,
    err,
    asked,
    run: (argv) => runCli(argv.split(' ').filter(Boolean), deps),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
