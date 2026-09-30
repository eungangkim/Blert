import { BlertError } from '../shared/errors.js';
import type { SoundKind } from '../shared/types.js';
import { platformGroup } from '../shared/platform.js';
import { t } from '../i18n/index.js';
import { suggest } from './suggest.js';
import type { Command, Ctx } from './types.js';

const KINDS: readonly SoundKind[] = ['up', 'down', 'account', 'warn'];

/** 알림 유형(up, down, account, warn). 생략하면 up */
function parseKind(raw: string | undefined): SoundKind {
  if (raw === undefined) return 'up';
  const hit = KINDS.find((k) => k === raw.toLowerCase());
  if (hit) return hit;
  const s = suggest(raw, KINDS);
  throw new BlertError(s ? 'err.soundKindDidYouMean' : 'err.soundKind', { value: raw, suggestion: s ?? '', kinds: KINDS.join(', ') });
}

export const testCommand: Command = {
  name: 'test',
  usageKeys: ['usage.test'],
  allowedOptions: [],
  async run({ rest, deps }: Ctx) {
    if (rest.length > 1) throw new BlertError('err.usage', { usage: t('usage.test'), example: 'blert test warn' });
    const kind = parseKind(rest[0]);
    await deps.notifier.test(kind);
    deps.io.out(t('test.done', { kind }));
    if (!(await deps.store.loadConfig()).soundEnabled) deps.io.out(t('test.soundOff'));
    return 0;
  },
};

export const soundCommand: Command = {
  name: 'sound',
  usageKeys: ['usage.sound.onoff', 'usage.sound.test'],
  allowedOptions: [],
  async run({ rest, deps }: Ctx) {
    const [subRaw, kindRaw, ...extra] = rest;
    const sub = ['on', 'off', 'test'].find((s) => s === subRaw?.toLowerCase());
    if (!sub) {
      const s = subRaw ? suggest(subRaw, ['on', 'off', 'test']) : undefined;
      throw new BlertError(s ? 'err.soundSub' : 'err.soundUsage', { value: subRaw ?? '', suggestion: s ?? '' });
    }
    if (extra.length > 0 || (sub !== 'test' && kindRaw !== undefined)) throw new BlertError('err.soundUsage');

    if (sub === 'on' || sub === 'off') {
      await deps.store.updateConfig((c) => {
        c.soundEnabled = sub === 'on';
      });
      deps.io.out(t(`sound.${sub}.done`));
      return 0;
    }

    const kind = parseKind(kindRaw);
    if (!(await deps.store.loadConfig()).soundEnabled) deps.io.out(t('sound.muted'));
    deps.io.out(t('sound.testing', { kind }));
    try {
      await deps.notifier.soundTest(kind);
    } catch (e) {
      throw new BlertError('err.soundTest', {
        reason: e instanceof Error ? e.message : String(e),
        guide: t(`notify.guide.sound.${platformGroup()}`),
      });
    }
    return 0;
  },
};
