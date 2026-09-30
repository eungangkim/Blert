#!/usr/bin/env node
import { createInterface, type Interface } from 'node:readline';
import { runCli } from './cli/index.js';
import type { Deps, Io, PresetService } from './cli/index.js';
import { Store } from './store/index.js';

/** 질문할 때만 stdin을 연다. 입력이 끝나면 ask는 null을 돌려준다. */
function createIo(): Io & { close(): void } {
  let rl: Interface | undefined;
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | undefined;
  let closed = false;

  const open = () => {
    rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        w(line);
      } else queue.push(line);
    });
    rl.on('close', () => {
      closed = true;
      waiter?.(null);
    });
  };

  return {
    out: (text) => void process.stdout.write(text + '\n'),
    err: (text) => void process.stderr.write(text + '\n'),
    ask(question) {
      process.stdout.write(question);
      if (!rl) open();
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => (waiter = resolve));
    },
    close: () => rl?.close(),
  };
}

// 프리셋 모듈(4단계) 연결 전까지의 임시 구현: 프리셋 없음
const noPresets: PresetService = { list: () => [], install: async () => 0 };

const io = createIo();
const deps: Deps = { store: new Store(), presets: noPresets, io };
const code = await runCli(process.argv.slice(2), deps);
io.close();
process.exitCode = code;
