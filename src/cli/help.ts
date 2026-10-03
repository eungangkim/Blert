import { t } from '../i18n/index.js';
import type { Command } from './types.js';

const indent = (lines: string[]) => lines.map((l) => `  ${l}`);

export function commandHelp(cmd: Command, advanced: boolean): string {
  const out = [t(`help.cmd.${cmd.name}.summary`), '', t('help.usageHeader'), ...indent(cmd.usageKeys.map((k) => t(k))), '', t('help.examplesHeader'), ...indent(t(`help.cmd.${cmd.name}.examples`).split('\n'))];
  if (advanced && cmd.advancedKeys) out.push('', t('help.advancedHeader'), ...cmd.advancedKeys.map((k) => t(k)));
  return out.join('\n');
}

export function topHelp(all: Command[], advanced: boolean): string {
  const commands = all.filter((c) => !c.hidden);
  const width = Math.max(...commands.map((c) => c.name.length));
  const out = [
    t('help.title'),
    '',
    t('help.usage'),
    '',
    t('help.commands'),
    ...indent(commands.map((c) => `${c.name.padEnd(width)}  ${t(`help.cmd.${c.name}.summary`)}`)),
    '',
  ];
  if (advanced) {
    out.push(t('help.advancedHeader'), ...commands.flatMap((c) => c.advancedKeys ?? []).map((k) => t(k)), '');
  } else {
    out.push(t('help.advancedHint'));
  }
  out.push(t('help.footer'));
  return out.join('\n');
}
