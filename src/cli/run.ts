import { BlertError } from '../shared/errors.js';
import { t } from '../i18n/index.js';
import type { Command, Ctx } from './types.js';

export const runCommand: Command = {
  name: 'run',
  usageKeys: ['usage.run'],
  allowedOptions: [],
  async run({ rest, args, deps }: Ctx) {
    if (rest.length > 0) throw new BlertError('err.usage', { usage: t('usage.run'), example: 'blert run' });
    return deps.runner.run({ verbose: args.flags.has('verbose') });
  },
};
