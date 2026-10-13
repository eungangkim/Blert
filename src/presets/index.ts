import type { Condition, RepeatPolicy, Rule } from '../shared/types.js';
import { BlertError } from '../shared/errors.js';
import { DEFAULT_REPEAT } from '../shared/defaults.js';
import type { Store } from '../store/index.js';
import type { ExternalPreset } from './external.js';

export * from './external.js';
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
  /** 내장 프리셋의 표시 이름(i18n 키) */
  nameKey?: string;
  /** 외부 프리셋의 표시 이름(파일에 적힌 글자, D-101) */
  name?: string;
  ruleCount: number;
  installed: boolean;
  /** 외부 프리셋의 출처(주소는 호스트+경로, 파일은 'file')와 해시 (D-107) */
  source?: string;
  sha256?: string;
}

/** 외부 프리셋을 설치하지 못하는 이유 (D-80) */
export type SlugConflict = 'builtin' | 'installed';

export interface PresetService {
  list(): Promise<PresetInfo[]>;
  /** 설치하고 등록된 규칙 수를 돌려준다 */
  install(slug: string): Promise<number>;
  /** 해당 프리셋 출처의 규칙만 삭제하고 삭제한 규칙 수를 돌려준다 */
  remove(slug: string): Promise<number>;
  /** 내장 슬러그이거나 이미 설치된 슬러그면 이유를 돌려준다 (D-80). 설치할 수 있으면 undefined */
  slugConflict(slug: string): Promise<SlugConflict | undefined>;
  /**
   * 검증을 마친 외부 프리셋을 설치한다 (v1.2, D-109). 규칙의 출처는 항상 `preset:<슬러그>`이고,
   * 설정 기록이 실패하면 추가한 규칙을 지워 되돌린다. 등록된 규칙 수를 돌려준다.
   */
  installExternal(preset: ExternalPreset, origin: { source: string; sha256: string }): Promise<number>;
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
      const builtin: PresetInfo[] = defs.map((d) => ({
        slug: d.slug,
        nameKey: d.nameKey,
        ruleCount: d.rules.length,
        installed: presets.some((p) => p.slug === d.slug),
      }));
      const external = presets.filter((p) => !defs.some((d) => d.slug === p.slug));
      if (external.length === 0) return builtin;
      const rules = await store.loadRules();
      return [
        ...builtin,
        ...external.map((p): PresetInfo => ({
          slug: p.slug,
          name: p.name ?? p.slug,
          ruleCount: rules.filter((r) => r.source === `preset:${p.slug}`).length,
          installed: true,
          ...(p.source !== undefined ? { source: p.source } : {}),
          ...(p.sha256 !== undefined ? { sha256: p.sha256 } : {}),
        })),
      ];
    },

    async slugConflict(slug) {
      if (defs.some((d) => d.slug === slug)) return 'builtin';
      const { presets } = await store.loadConfig();
      return presets.some((p) => p.slug === slug) ? 'installed' : undefined;
    },

    async installExternal(preset, origin) {
      const conflict = await this.slugConflict(preset.slug);
      if (conflict) throw new BlertError(conflict === 'builtin' ? 'err.presetBuiltinName' : 'err.presetInstalled', { slug: preset.slug });
      const source = `preset:${preset.slug}` as Rule['source'];
      const added = await store.addRules(preset.rules.map((r) => ({ ...r, source, enabled: true })));
      try {
        await store.updateConfig((c) => {
          c.presets.push({ slug: preset.slug, version: preset.version, name: preset.name, source: origin.source, sha256: origin.sha256 });
        });
      } catch (e) {
        await store.deleteBySource(source); // 기록 없이 규칙만 남지 않게 한다
        throw e;
      }
      return added.length;
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
      const { presets } = await store.loadConfig();
      // 설정에 기록된 외부 프리셋도 제거할 수 있다
      if (!defs.some((d) => d.slug === slug) && !presets.some((p) => p.slug === slug)) find(slug);
      if (!presets.some((p) => p.slug === slug)) throw new BlertError('err.presetNotInstalled', { slug });
      const ids = await store.deleteBySource(`preset:${slug}`);
      await store.updateConfig((c) => {
        c.presets = c.presets.filter((p) => p.slug !== slug);
      });
      return ids.length;
    },
  };
}
