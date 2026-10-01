#!/usr/bin/env node
import { createInterface, type Interface } from 'node:readline';
import { runCli } from './cli/index.js';
import type { Deps, Io } from './cli/index.js';
import { createPresetService } from './presets/index.js';
import { createNotifier } from './notify/index.js';
import { createRunner } from './runtime/index.js';
import { Store } from './store/index.js';
import { createKeyService, createNapiKeychain } from './security/index.js';
import { networkMode, type NetworkMode } from './shared/network.js';
import { BlertError } from './shared/errors.js';
import { t } from './i18n/index.js';

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

const io = createIo();

// 개발자 전용 테스트넷 모드는 환경변수로만 켠다. 잘못된 값은 오타로 보고 실행하지 않는다.
let network: NetworkMode = 'mainnet';
try {
  network = networkMode();
} catch (e) {
  if (!(e instanceof BlertError)) throw e;
  io.err(t(e.messageKey, e.params));
  process.exit(e.exitCode);
}

const store = new Store();
const soundEnabledForTest = async () => (await store.loadConfig()).soundEnabled;
const notifier = createNotifier({ out: (line) => io.out(line), soundEnabled: soundEnabledForTest });
const soundEnabled = async () => (await store.loadConfig()).soundEnabled;
const runner = createRunner({
  dir: store.dir,
  io,
  makeNotifier: (logger) => createNotifier({ out: (line) => io.out(line), soundEnabled, logger }),
});
const keys = createKeyService({ keychain: createNapiKeychain(), mode: network });
const deps: Deps = { store, presets: createPresetService(store), notifier, runner, keys, network, io };
const code = await runCli(process.argv.slice(2), deps);
io.close();
process.exitCode = code;
