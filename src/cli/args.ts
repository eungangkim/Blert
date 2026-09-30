import { BlertError } from '../shared/errors.js';
import { t } from '../i18n/index.js';
import { suggest } from './suggest.js';
import type { ParsedArgs } from './types.js';

export const VALUE_OPTIONS = ['mode', 'sound', 'name'];
export const FLAG_OPTIONS = ['help', 'advanced', 'all', 'verbose'];
/** 모든 명령에서 허용되는 옵션 */
export const GLOBAL_OPTIONS = ['help', 'advanced', 'verbose'];

/** `--이름 값`, `--이름=값`, `--플래그`, `-h`를 나눈다. 셸 특수문자는 문법에 쓰지 않는다 (D-19). */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h') {
      flags.add('help');
    } else if (a.startsWith('--') && a.length > 2) {
      const [name = '', ...inline] = a.slice(2).split('=');
      if (FLAG_OPTIONS.includes(name)) {
        flags.add(name);
      } else if (VALUE_OPTIONS.includes(name)) {
        const value = inline.length ? inline.join('=') : argv[++i];
        if (value === undefined || value.startsWith('--')) {
          throw new BlertError('err.optionValue', { option: name, example: t(`example.option.${name}`) });
        }
        values.set(name, value);
      } else {
        const s = suggest(name, [...FLAG_OPTIONS, ...VALUE_OPTIONS]);
        throw s
          ? new BlertError('err.didYouMeanOption', { input: name, suggestion: s })
          : new BlertError('err.unknownOption', { input: name });
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, values, flags };
}
