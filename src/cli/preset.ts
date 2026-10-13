import { BlertError } from '../shared/errors.js';
import { t } from '../i18n/index.js';
import { suggest } from './suggest.js';
import { presetName, renderTable } from './format.js';
import { isBuiltinName, presetInstallExternal } from './presetinstall.js';
import type { Command, Ctx } from './types.js';

const SUBS = ['list', 'install', 'remove'] as const;
type Sub = (typeof SUBS)[number];

const usageError = (sub: Sub) => new BlertError('err.usage', { usage: t(`usage.preset.${sub}`), example: t(`example.preset.${sub}`) });

export const presetCommand: Command = {
  name: 'preset',
  usageKeys: ['usage.preset.list', 'usage.preset.install', 'usage.preset.installExternal', 'usage.preset.remove'],
  allowedOptions: ['sha256'],
  async run({ rest, args, deps }: Ctx) {
    const [subRaw, slugRaw, ...extra] = rest;
    const sub = SUBS.find((s) => s === subRaw?.toLowerCase());
    if (!sub) {
      if (!subRaw) throw new BlertError('err.usage', { usage: t('usage.preset.list'), example: t('example.preset.install') });
      const s = suggest(subRaw, SUBS);
      throw new BlertError(s ? 'err.presetSubDidYouMean' : 'err.presetSub', { value: subRaw, suggestion: s ?? '', subs: SUBS.join(', ') });
    }
    const { io, presets } = deps;
    const sha256 = args.values.get('sha256');
    // --sha256은 파일·주소로 설치할 때만 쓴다 (D-79, D-105)
    if (sha256 !== undefined && !(sub === 'install' && slugRaw !== undefined && !isBuiltinName(slugRaw))) throw new BlertError('err.presetShaOnlyExternal');
    if (sub === 'install' && slugRaw !== undefined && extra.length === 0 && !isBuiltinName(slugRaw)) return presetInstallExternal(deps, slugRaw, sha256);
    const infos = await presets.list();

    if (sub === 'list') {
      if (slugRaw !== undefined) throw usageError(sub);
      // 외부 프리셋이 있으면 출처와 해시 앞 8자리를 함께 보여 준다 (D-107)
      const withSource = infos.some((p) => p.source !== undefined);
      const header = ['slug', 'name', 'rules', 'status', ...(withSource ? ['source'] : [])].map((k) => t(`preset.col.${k}`));
      const rows = infos.map((p) => [
        p.slug,
        presetName(p),
        String(p.ruleCount),
        t(p.installed ? 'preset.status.installed' : 'preset.status.available'),
        ...(withSource ? [p.source ? `${p.source}${p.sha256 ? ` (${p.sha256.slice(0, 8)}…)` : ''}` : '-'] : []),
      ]);
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
    io.out(t(`preset.${sub}.done`, { slug, name: presetName(info), count }));
    return 0;
  },
};
