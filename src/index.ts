#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { runCli } from './cli/index.js';
import type { ChannelPort, DaemonPort, Deps, DownloaderPort, Io, VoicePort } from './cli/index.js';
import { download } from './shared/download.js';
import type { SoundKind } from './shared/types.js';
import { activeQuiet } from './shared/quiet.js';
import { createServicePort } from './service-win.js';
import { createPresetService } from './presets/index.js';
import { TelegramClient, VoiceEngine, createNotifier, renderAlert, type ChannelSource } from './notify/index.js';
import { createRunner } from './runtime/index.js';
import { HistoryRecorder, Store } from './store/index.js';
import { createKeyService, createNapiKeychain, createNapiSecretStore } from './security/index.js';
import { networkMode, type NetworkMode } from './shared/network.js';
import { BlertError } from './shared/errors.js';
import { osLocale, resolveLanguage, setLanguage, t } from './i18n/index.js';

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
    drain: () => void (queue.length = 0),
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

// 메시지 언어 (v1.4, D-123·D-125): 프로세스가 시작할 때 한 번 정한다. BLERT_LANG > 설정 > OS 로캘 > ko
setLanguage(
  resolveLanguage({
    env: process.env.BLERT_LANG,
    config: await store.loadConfig().then((c) => c.language, () => undefined), // 설정을 읽지 못해도 명령은 계속된다
    locale: osLocale(),
  }).language,
);

// 외부 알림 채널 (v1.0, D-69~D-73). 등록 정보와 토큰은 보내는 순간에 읽어, 실행 중인 데몬도 channel add/remove를 바로 따른다.
const secrets = createNapiSecretStore();
const channelSource: ChannelSource = {
  load: async () => {
    const c = (await store.loadConfig()).channels?.find((x) => x.type === 'telegram');
    return c ? { chatId: c.chatId, includeAccount: c.includeAccount } : undefined;
  },
  token: () => secrets.load().catch(() => undefined),
};
const telegram = new TelegramClient();
const channel: ChannelPort = {
  keychainAvailable: () => secrets.available(),
  async listChats(token) {
    const r = await telegram.listChats(token);
    if (r.ok) return { ok: true, chats: r.value };
    return { ok: false, reason: r.reason === 'unauthorized' ? 'rejected' : r.reason === 'network' || r.reason === 'blocked' ? 'network' : 'http' };
  },
  async send(chatId, text, token) {
    const tok = token ?? (await secrets.load().catch(() => undefined));
    if (!tok) return { ok: false, reason: 'token missing' };
    const r = await telegram.sendMessage(tok, chatId, text);
    return r.ok ? { ok: true } : { ok: false, reason: `${r.reason}${r.status ? ` ${r.status}` : ''}` };
  },
  saveToken: (token) => secrets.save(token),
  removeToken: () => secrets.remove(),
  hasToken: async () => (await secrets.load().catch(() => undefined)) !== undefined,
};
// 사용자 소리 (v1.1, D-82·D-95): 재생할 때마다 설정을 읽어, 실행 중인 데몬도 sound set/reset을 바로 따른다.
const userSound = (kind: SoundKind) => store.userSoundPath(kind);
// 주소 방식 내려받기 (D-78·D-93): 사용자가 명령에 입력한 주소로만 접속한다
const downloader: DownloaderPort = { download: (url, o) => download(url, { maxBytes: o.maxBytes }) };
// 음성 알림 (v1.3, D-111·D-117): OS 내장 음성만 쓰고, 설정은 알림을 읽을 때마다 읽어 실행 중인 데몬도 바로 따른다.
const voiceEngine = new VoiceEngine();
const voice: VoicePort = { list: () => voiceEngine.list(), speak: (text, name) => voiceEngine.speak(text, name) };
const voiceConfig = { engine: voiceEngine, config: async () => (await store.loadConfig()).voice };
// 조용한 시간 (v1.5, D-135~D-141): 알림을 보낼 때마다 설정을 읽어, 실행 중인 데몬도 snooze·quiet를 바로 따른다.
const quiet = async () => activeQuiet((await store.loadConfig()).quiet, Date.now());
// 알림 기록 (v1.5, D-142~D-145): 1초 단위로 모아 쓰고, `history off`는 쓰기 직전에 반영한다. 저장 실패는 한 번만 알린다.
let historyWarned = false;
const recorder = new HistoryRecorder({
  append: (entries) => store.appendHistory(entries),
  enabled: () => store.historyEnabled().catch(() => true),
  onError: (e) => {
    if (historyWarned) return;
    historyWarned = true;
    io.err(t('history.writeFailed', { reason: e instanceof Error ? e.message : String(e) }));
  },
});
const record = (entries: Parameters<HistoryRecorder['add']>[0]) => recorder.add(entries);
const soundEnabledForTest = async () => (await store.loadConfig()).soundEnabled;
const notifier = createNotifier({ out: (line) => io.out(line), soundEnabled: soundEnabledForTest, userSound, voice: voiceConfig, channel: { source: channelSource }, quiet });
const soundEnabled = async () => (await store.loadConfig()).soundEnabled;
const keys = createKeyService({ keychain: createNapiKeychain(), mode: network });
const runner = createRunner({
  dir: store.dir,
  io,
  keys,
  network,
  // 데몬에는 터미널이 없어 console 어댑터를 쓰지 않는다. 알림 전체는 로그에 남는다 (D-55)
  makeNotifier: (logger, mode) => createNotifier({ out: mode === 'daemon' ? () => {} : (line) => io.out(line), console: mode !== 'daemon', soundEnabled, userSound, voice: voiceConfig, logger, channel: { source: channelSource }, quiet, record }),
});

/** 같은 실행 파일을 숨김 명령(daemon-run)으로 분리 실행한다 (D-54). 표준 출력·오류는 로그 폴더의 daemon.err로 보낸다. */
const daemon: DaemonPort = {
  launch(o) {
    mkdirSync(store.logsDir, { recursive: true });
    const fd = openSync(join(store.logsDir, 'daemon.err'), 'w'); // 시작할 때마다 비운다 (비정상 종료 때 남은 오류 출력만 담는다)
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'daemon-run', ...(o?.service ? ['--service'] : [])], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
    closeSync(fd);
    const exit = new Promise<number>((resolve) => {
      child.once('exit', (code) => resolve(code ?? -1));
      child.once('error', () => resolve(-1));
    });
    return { pid: child.pid ?? -1, exit, detach: () => child.unref() };
  },
  kill(pid) {
    try {
      process.kill(pid);
    } catch {
      // 이미 종료됨
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
/** logs -f 가 Ctrl+C로 깔끔하게 끝나도록, 호출한 때부터 Ctrl+C를 가로챈다 */
const interrupt = (): AbortSignal => {
  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort());
  return ac.signal;
};
const service = createServicePort();
const deps: Deps = { store, presets: createPresetService(store), notifier, runner, keys, network, daemon, service, channel, downloader, voice, renderAlert, interrupt, io };
const code = await runCli(process.argv.slice(2), deps);
await recorder.flush(); // 종료할 때 모아 둔 기록을 마저 쓴다
io.close();
process.exitCode = code;
