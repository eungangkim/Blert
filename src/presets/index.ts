import type { Condition, RepeatPolicy, Rule } from '../shared/types.js';
import { BlertError } from '../shared/errors.js';
import { DEFAULT_REPEAT } from '../shared/defaults.js';
import type { Store } from '../store/index.js';
import majorSwing from './major-swing.json' with { type: 'json' };
import volumeBurst from './volume-burst.json' with { type: 'json' };
import futuresHeat from './futures-heat.json' with { type: 'json' };

/** 프리셋 정의(D-23). repeat를 생략하면 유형별 기본 정책을 쓴다 (FR-REP-02). */
export interface PresetDef {
  slug: string;
  version: number;
  nameKey: string;
  rules: { type: Rule['type']; market: Rule['market']; symbol: string; condition: Condition; repeat?: RepeatPolicy }[];
}

export interface PresetInfo {
  slug: string;
  nameKey: string;
  ruleCount: number;
  installed: boolean;
}

export interface PresetService {
  list(): Promise<PresetInfo[]>;
  /** 설치하고 등록된 규칙 수를 돌려준다 */
  install(slug: string): Promise<number>;
  /** 해당 프리셋 출처의 규칙만 삭제하고 삭제한 규칙 수를 돌려준다 */
  remove(slug: string): Promise<number>;
}

// JSON import는 타입이 넓게 추론되므로 여기서 한 번 좁힌다. 형식은 test/presets에서 검증한다.
export const PRESETS = [majorSwing, volumeBurst, futuresHeat] as unknown as PresetDef[];

export function createPresetService(store: Store, defs: PresetDef[] = PRESETS): PresetService {
  const slugs = defs.map((d) => d.slug).join(', ');
  const find = (slug: string): PresetDef => {
    const def = defs.find((d) => d.slug === slug);
    if (!def) throw new BlertError('err.presetUnknown', { value: slug, slugs });
    return def;
  };

  return {
    async list() {
      const { presets } = await store.loadConfig();
      return defs.map((d) => ({
        slug: d.slug,
        nameKey: d.nameKey,
        ruleCount: d.rules.length,
        installed: presets.some((p) => p.slug === d.slug),
      }));
    },

    async install(slug) {
      const def = find(slug);
      const { presets } = await store.loadConfig();
      if (presets.some((p) => p.slug === slug)) throw new BlertError('err.presetInstalled', { slug });
      const added = await store.addRules(
        def.rules.map((r) => ({
          type: r.type,
          market: r.market,
          symbol: r.symbol,
          condition: r.condition,
          repeat: r.repeat ?? DEFAULT_REPEAT[r.type],
          source: `preset:${slug}` as Rule['source'],
          enabled: true,
        })),
      );
      await store.updateConfig((c) => {
        if (!c.presets.some((p) => p.slug === slug)) c.presets.push({ slug, version: def.version });
      });
      return added.length;
    },

    async remove(slug) {
      find(slug);
      const { presets } = await store.loadConfig();
      if (!presets.some((p) => p.slug === slug)) throw new BlertError('err.presetNotInstalled', { slug });
      const ids = await store.deleteBySource(`preset:${slug}`);
      await store.updateConfig((c) => {
        c.presets = c.presets.filter((p) => p.slug !== slug);
      });
      return ids.length;
    },
  };
}
