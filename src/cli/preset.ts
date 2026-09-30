import { BlertError } from '../shared/errors.js';
import { t } from '../i18n/index.js';
import { suggest } from './suggest.js';
import { renderTable } from './format.js';
import type { Command, Ctx } from './types.js';

const SUBS = ['list', 'install', 'remove'] as const;
type Sub = (typeof SUBS)[number];

const usageError = (sub: Sub) => new BlertError('err.usage', { usage: t(`usage.preset.${sub}`), example: t(`example.preset.${sub}`) });

export const presetCommand: Command = {
  name: 'preset',
  usageKeys: ['usage.preset.list', 'usage.preset.install', 'usage.preset.remove'],
  allowedOptions: [],
  async run({ rest, deps }: Ctx) {
    const [subRaw, slugRaw, ...extra] = rest;
    const sub = SUBS.find((s) => s === subRaw?.toLowerCase());
    if (!sub) {
      if (!subRaw) throw new BlertError('err.usage', { usage: t('usage.preset.list'), example: t('example.preset.install') });
      const s = suggest(subRaw, SUBS);
      throw new BlertError(s ? 'err.presetSubDidYouMean' : 'err.presetSub', { value: subRaw, suggestion: s ?? '', subs: SUBS.join(', ') });
    }
    const { io, presets } = deps;
    const infos = await presets.list();

    if (sub === 'list') {
      if (slugRaw !== undefined) throw usageError(sub);
      const header = ['slug', 'name', 'rules', 'status'].map((k) => t(`preset.col.${k}`));
      const rows = infos.map((p) => [p.slug, t(p.nameKey), String(p.ruleCount), t(p.installed ? 'preset.status.installed' : 'preset.status.available')]);
      io.out(renderTable([header, ...rows]));
      return 0;
    }

    if (!slugRaw || extra.length > 0) throw usageError(sub);
    const slug = slugRaw.toLowerCase();
    const info = infos.find((p) => p.slug === slug);
    if (!info) {
      const s = suggest(slug, infos.map((p) => p.slug));
      throw new BlertError(s ? 'err.presetUnknownDidYouMean' : 'err.presetUnknown', {
        value: slugRaw,
        suggestion: s ?? '',
        slugs: infos.map((p) => p.slug).join(', '),
      });
    }
    const count = sub === 'install' ? await presets.install(slug) : await presets.remove(slug);
    io.out(t(`preset.${sub}.done`, { slug, name: t(info.nameKey), count }));
    return 0;
  },
};
