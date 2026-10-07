import { BlertError, ExitCode } from '../shared/errors.js';
import { mask } from '../shared/logger.js';
import { t } from '../i18n/index.js';
import { GLOBAL_OPTIONS, parseArgs } from './args.js';
import { suggest } from './suggest.js';
import { commandHelp, topHelp } from './help.js';
import { addCommand } from './add.js';
import { delCommand, listCommand, pauseCommand, resumeCommand } from './manage.js';
import { initCommand } from './init.js';
import { presetCommand } from './preset.js';
import { soundCommand, testCommand } from './sound.js';
import { runCommand } from './run.js';
import { keyCommand } from './key.js';
import { daemonRunCommand, startCommand, statusCommand, stopCommand } from './daemon.js';
import { logsCommand } from './logs.js';
import { serviceCommand } from './service.js';
import { channelCommand } from './channel.js';
import { formatLocalDateTime } from './format.js';
import { RUN_LOCK_STALE_MS } from '../shared/defaults.js';
import type { Command, Deps } from './types.js';

export type { Deps, Io, PresetService, NotifierPort, Runner, DaemonPort, ServicePort, ChannelPort, Command } from './types.js';

/** 명령 레지스트리. 도움말과 오타 제안이 이 목록을 쓴다. */
export const defaultCommands: Command[] = [initCommand, addCommand, listCommand, delCommand, pauseCommand, resumeCommand, presetCommand, soundCommand, testCommand, runCommand, startCommand, stopCommand, statusCommand, logsCommand, serviceCommand, channelCommand, keyCommand, daemonRunCommand];

/** 이 명령들은 직접 실행 상태를 다루므로 죽은 데몬 경고를 따로 하지 않는다 */
const NO_DAEMON_WARNING = ['start', 'stop', 'status', 'run', 'daemon-run'];

/**
 * 데몬이 소리 없이 죽었으면(PID 파일은 남았는데 주인이 없음) 어떤 명령이든 한 줄로 경고한다 (D-61, NFR-REL-02).
 * 경고 확인이 실패해도 명령 실행을 막지 않는다.
 */
async function warnIfDaemonDied(deps: Deps): Promise<void> {
  try {
    const lock = await deps.store.inspectRunLock(deps.daemon.now(), RUN_LOCK_STALE_MS);
    if (lock.state === 'stale' && lock.file.mode === 'daemon') {
      deps.io.err(t('warn.daemonDied', { alive: formatLocalDateTime(Date.parse(lock.file.heartbeatAt)) }));
    }
  } catch {
    // 경고를 못 해도 명령은 계속한다
  }
}

function report(deps: Deps, e: unknown): number {
  if (e instanceof BlertError) {
    deps.io.err(t(e.messageKey, e.params));
    return e.exitCode;
  }
  const detail = mask(e instanceof Error ? e.message : String(e));
  deps.io.err(t('err.internal', { detail, logsDir: deps.store.logsDir }));
  return ExitCode.internal;
}

/** 진입점이 부르는 CLI 본체. 종료 코드를 돌려준다. */
export async function runCli(argv: string[], deps: Deps, commands: Command[] = defaultCommands): Promise<number> {
  try {
    const args = parseArgs(argv);
    const advanced = args.flags.has('advanced');
    const name = args.positionals[0];
    const cmd = name === undefined ? undefined : commands.find((c) => c.name === name);

    if (name === undefined || (!cmd && args.flags.has('help'))) {
      deps.io.out(topHelp(commands, advanced));
      return ExitCode.ok;
    }
    if (!cmd) {
      const s = suggest(name, commands.filter((c) => !c.hidden).map((c) => c.name));
      throw new BlertError(s ? 'err.didYouMean' : 'err.unknownCommand', { input: name, suggestion: s ?? '' });
    }
    if (args.flags.has('help')) {
      deps.io.out(commandHelp(cmd, advanced));
      return ExitCode.ok;
    }
    const used = [...args.values.keys(), ...args.flags].filter((o) => !GLOBAL_OPTIONS.includes(o));
    const bad = used.find((o) => !cmd.allowedOptions.includes(o));
    if (bad) throw new BlertError('err.optionNotAllowed', { option: bad, command: cmd.name });

    if (!NO_DAEMON_WARNING.includes(cmd.name)) await warnIfDaemonDied(deps);
    return await cmd.run({ args, rest: args.positionals.slice(1), deps });
  } catch (e) {
    return report(deps, e);
  }
}
