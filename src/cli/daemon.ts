import { BlertError, ExitCode, type ExitCodeValue } from '../shared/errors.js';
import { RUN_LOCK_STALE_MS } from '../shared/defaults.js';
import { pidAlive, type PidFile, type StatusFile } from '../store/index.js';
import { t } from '../i18n/index.js';
import { formatLocalDateTime } from './format.js';
import type { Command, Ctx } from './types.js';

/** `start`가 데몬의 준비 완료를 기다리는 시간 (D-58)과 `stop`이 정상 종료를 기다리는 시간 (D-57) */
export const START_WAIT_MS = 15_000;
export const STOP_WAIT_MS = 10_000;
const POLL_MS = 200;
const KILL_WAIT_MS = 2_000;

const noArgs = (cmd: string, rest: string[]) => {
  if (rest.length > 0) throw new BlertError('err.usage', { usage: t(`usage.${cmd}`), example: `blert ${cmd}` });
};

/** 데몬 안에서 실행되는 숨김 내부 명령 (D-54). 사용자가 직접 부르지 않는다. */
export const daemonRunCommand: Command = {
  name: 'daemon-run',
  hidden: true,
  usageKeys: [],
  allowedOptions: [],
  async run({ args, deps }: Ctx) {
    return deps.runner.daemon({ verbose: args.flags.has('verbose') });
  },
};

/** `blert start`: 데몬을 분리 실행하고 준비 완료(또는 실패)를 기다려 결과를 알린다 (D-54, D-58) */
export const startCommand: Command = {
  name: 'start',
  usageKeys: ['usage.start'],
  allowedOptions: [],
  async run({ rest, deps }: Ctx) {
    noArgs('start', rest);
    const { store, daemon, io } = deps;
    const lock = await store.inspectRunLock(daemon.now(), RUN_LOCK_STALE_MS);
    if (lock.state === 'running') throw new BlertError(lock.file.mode === 'daemon' ? 'err.runAlreadyDaemon' : 'err.runAlready', { pid: lock.file.pid });

    io.out(t('start.waiting'));
    const child = daemon.launch();
    let exited: number | undefined;
    void child.exit.then((code) => {
      exited = code;
    });

    const fail = async (status: StatusFile | undefined): Promise<never> => {
      await store.clearStatus(child.pid);
      const f = status?.failure;
      if (f) throw new BlertError(f.messageKey, f.params, f.exitCode as ExitCodeValue);
      throw new BlertError('err.startExited', { code: exited ?? '?' }, ExitCode.internal);
    };

    const deadline = daemon.now() + START_WAIT_MS;
    for (;;) {
      const status = await store.readStatus();
      if (status?.pid === child.pid) {
        if (status.state === 'ready') {
          child.detach();
          io.out(t('start.ok', { pid: child.pid }));
          return 0;
        }
        if (status.state === 'failed') return fail(status);
      }
      if (exited !== undefined) return fail(await store.readStatus().then((s) => (s?.pid === child.pid ? s : undefined)));
      if (daemon.now() >= deadline) {
        daemon.kill(child.pid); // 준비되지 못한 데몬을 남기지 않는다
        await store.releaseRunLock(child.pid);
        await store.clearStatus(child.pid);
        throw new BlertError('err.startTimeout', { seconds: START_WAIT_MS / 1000 }, ExitCode.internal);
      }
      await daemon.sleep(POLL_MS);
    }
  },
};

/** `blert stop`: 종료 요청 파일로 정상 종료를 요청하고, 응답이 없으면 강제 종료한다 (D-57) */
export const stopCommand: Command = {
  name: 'stop',
  usageKeys: ['usage.stop'],
  allowedOptions: [],
  async run({ rest, deps }: Ctx) {
    noArgs('stop', rest);
    const { store, daemon, io } = deps;
    const lock = await store.inspectRunLock(daemon.now(), RUN_LOCK_STALE_MS);
    if (lock.state === 'none') {
      io.out(t('stop.notRunning'));
      return 0;
    }
    if (lock.state === 'stale') {
      io.out(t('stop.crashed', { alive: formatLocalDateTime(Date.parse(lock.file.heartbeatAt)) }));
      return 0;
    }
    if (lock.file.mode !== 'daemon') throw new BlertError('err.stopForeground', { pid: lock.file.pid });

    const pid = lock.file.pid;
    await store.requestStop(daemon.now());
    io.out(t('stop.requested', { pid }));
    const gone = async () => (await store.readRunLock())?.pid !== pid || !pidAlive(pid);
    const deadline = daemon.now() + STOP_WAIT_MS;
    while (daemon.now() < deadline) {
      if (await gone()) {
        io.out(t('stop.done'));
        return 0;
      }
      await daemon.sleep(POLL_MS);
    }
    // 정상 종료에 응답하지 않는다: 강제 종료하고, 남은 파일을 정리한다
    daemon.kill(pid);
    const killDeadline = daemon.now() + KILL_WAIT_MS;
    while (pidAlive(pid) && daemon.now() < killDeadline) await daemon.sleep(POLL_MS);
    await store.releaseRunLock(pid);
    await store.clearStatus(pid);
    await store.clearStopRequest();
    io.out(t('stop.forced', { seconds: STOP_WAIT_MS / 1000 }));
    return 0;
  },
};

const connState = (state: string) => (t(`conn.state.${state}`) === `conn.state.${state}` ? state : t(`conn.state.${state}`));

function describeStatus(file: PidFile, status: StatusFile | undefined): string[] {
  const lines = [t('status.running', { pid: file.pid })];
  lines.push(t('status.times', { started: formatLocalDateTime(Date.parse(file.startedAt)), alive: formatLocalDateTime(Date.parse(file.heartbeatAt)) }));
  if (!status || status.pid !== file.pid) {
    lines.push(t('status.starting'));
    return lines;
  }
  if (status.state === 'starting') lines.push(t('status.starting'));
  lines.push(t('status.rules', { total: status.rules.spot + status.rules.futures, spot: status.rules.spot, futures: status.rules.futures }));
  if (status.connections.length) lines.push(t('status.connections', { list: status.connections.map((c) => `${c.stream} ${connState(c.state)}`).join(', ') }));
  if (status.lastGap) {
    lines.push(
      t('status.gap', {
        from: formatLocalDateTime(Date.parse(status.lastGap.from)),
        to: formatLocalDateTime(Date.parse(status.lastGap.to)),
        reason: t(`gap.reason.${status.lastGap.reason}`),
        ongoing: status.lastGap.ongoing ? t('status.gapOngoing') : '',
      }).trim(),
    );
  }
  return lines;
}

/** `blert status`: 실행 여부와 감시 상태 (D-59) */
export const statusCommand: Command = {
  name: 'status',
  usageKeys: ['usage.status'],
  allowedOptions: [],
  async run({ rest, deps }: Ctx) {
    noArgs('status', rest);
    const { store, daemon, io } = deps;
    const lock = await store.inspectRunLock(daemon.now(), RUN_LOCK_STALE_MS);
    if (lock.state === 'none') {
      io.out(t('status.none'));
      return 0;
    }
    if (lock.state === 'stale') {
      io.out(t('status.crashed', { alive: formatLocalDateTime(Date.parse(lock.file.heartbeatAt)), mode: t(`status.mode.${lock.file.mode ?? 'foreground'}`) }));
      return 0;
    }
    if (lock.file.mode !== 'daemon') {
      io.out(t('status.foreground', { pid: lock.file.pid }));
      return 0;
    }
    io.out(describeStatus(lock.file, await store.readStatus()).join('\n'));
    return 0;
  },
};
