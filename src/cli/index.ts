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
import type { Command, Deps } from './types.js';

export type { Deps, Io, PresetService, NotifierPort, Runner, Command } from './types.js';

/** 명령 레지스트리. 도움말과 오타 제안이 이 목록을 쓴다. */
export const defaultCommands: Command[] = [initCommand, addCommand, listCommand, delCommand, pauseCommand, resumeCommand, presetCommand, soundCommand, testCommand, runCommand];

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
      const s = suggest(name, commands.map((c) => c.name));
      throw new BlertError(s ? 'err.didYouMean' : 'err.unknownCommand', { input: name, suggestion: s ?? '' });
    }
    if (args.flags.has('help')) {
      deps.io.out(commandHelp(cmd, advanced));
      return ExitCode.ok;
    }
    const used = [...args.values.keys(), ...args.flags].filter((o) => !GLOBAL_OPTIONS.includes(o));
    const bad = used.find((o) => !cmd.allowedOptions.includes(o));
    if (bad) throw new BlertError('err.optionNotAllowed', { option: bad, command: cmd.name });

    return await cmd.run({ args, rest: args.positionals.slice(1), deps });
  } catch (e) {
    return report(deps, e);
  }
}
