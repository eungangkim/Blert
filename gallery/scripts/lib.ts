import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { countByType, EXTERNAL_PRESET_LIMITS, needsKey, parseExternalPreset, SLUG_FORMAT } from '../../src/presets/external.js';
import { parseTheme, localThemePath, SOUND_KINDS, THEME_MAX_BYTES } from '../../src/shared/theme.js';
import { inspectWav, sha256Hex } from '../../src/shared/wav.js';

/** 갤러리 원본 검사와 index.json 생성 (D-85, D-133). 갤러리의 파일은 blert가 설치할 때 쓰는 검증기를 그대로 통과해야 한다 */
export const INDEX_SCHEMA_VERSION = 1;
/** 갤러리에 올릴 수 있는 라이선스: 소리는 CC0뿐이다 (D-84). 프리셋은 CC0 또는 MIT */
export const SOUND_LICENSES: readonly string[] = ['CC0-1.0'];
export const PRESET_LICENSES: readonly string[] = ['CC0-1.0', 'MIT'];
/** 매수·매도 권유나 수익 보장으로 읽힐 수 있는 표현 (D-87⑤, D-133). 이름·설명에 쓰지 않는다 */
const FORBIDDEN_WORDING = new RegExp(
  '추천|매수|매도|수익|보장|필승|대박|확실|무조건|사세요|파세요|\\b(buy|sell|profit|profits|guarantee|guaranteed|recommend|recommended|signal|signals)\\b',
  'i',
);

export interface PresetEntry {
  slug: string;
  name: string;
  description?: string;
  license: string;
  author?: string;
  version: number;
  /** gallery/ 기준 경로 */
  file: string;
  sha256: string;
  bytes: number;
  ruleCount: number;
  types: Record<string, number>;
  needsKey: boolean;
}
export interface ThemeEntry {
  slug: string;
  name: string;
  version: string;
  license: string;
  file: string;
  sha256: string;
  bytes: number;
  sounds: Record<string, { file: string; sha256: string; bytes: number; ms: number }>;
}
export interface GalleryIndex {
  schemaVersion: number;
  presets: PresetEntry[];
  themes: ThemeEntry[];
}

const exists = async (dir: string): Promise<string[]> => readdir(dir).catch(() => []);

/** gallery 폴더를 읽어 목록을 만든다. 문제가 있으면 사람이 읽을 수 있는 문장으로 모두 모아 돌려준다 */
export async function buildIndex(root: string): Promise<{ index: GalleryIndex; problems: string[] }> {
  const problems: string[] = [];
  const presets: PresetEntry[] = [];
  const themes: ThemeEntry[] = [];

  for (const file of (await exists(join(root, 'presets'))).filter((f) => f.endsWith('.json')).sort()) {
    const at = `presets/${file}`;
    const bytes = await readFile(join(root, at));
    if (bytes.length > EXTERNAL_PRESET_LIMITS.maxBytes) {
      problems.push(`${at}: 파일이 ${EXTERNAL_PRESET_LIMITS.maxBytes}바이트를 넘습니다`);
      continue;
    }
    const r = parseExternalPreset(bytes.toString('utf8'));
    if (!r.ok) {
      problems.push(`${at}: 설치 검증을 통과하지 못합니다 (${JSON.stringify(r.problem)})`);
      continue;
    }
    const p = r.value;
    if (`${p.slug}.json` !== file) problems.push(`${at}: 파일 이름은 슬러그(${p.slug}.json)와 같아야 합니다`);
    if (!PRESET_LICENSES.includes(p.license)) problems.push(`${at}: 라이선스 ${p.license}은(는) 허용되지 않습니다 (${PRESET_LICENSES.join(', ')})`);
    for (const [label, value] of [['name', p.name], ['description', p.description], ...p.rules.map((x, i) => [`rules[${i}].name`, x.name] as const)] as const) {
      if (value && FORBIDDEN_WORDING.test(value)) problems.push(`${at}: ${label}에 권유·보장으로 읽힐 수 있는 표현이 있습니다 ("${value}")`);
    }
    presets.push({
      slug: p.slug,
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      license: p.license,
      ...(p.author ? { author: p.author } : {}),
      version: p.version,
      file: at,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      ruleCount: p.rules.length,
      types: countByType(p.rules),
      needsKey: p.rules.some(needsKey),
    });
  }

  for (const dir of (await exists(join(root, 'sounds'))).sort()) {
    const base = `sounds/${dir}`;
    if (!SLUG_FORMAT.test(dir)) {
      problems.push(`${base}: 폴더 이름은 영문 소문자·숫자·하이픈 3~40자여야 합니다`);
      continue;
    }
    const themeBytes = await readFile(join(root, base, 'theme.json')).catch(() => undefined);
    if (!themeBytes) {
      problems.push(`${base}: theme.json이 없습니다`);
      continue;
    }
    if (themeBytes.length > THEME_MAX_BYTES) {
      problems.push(`${base}/theme.json: 파일이 ${THEME_MAX_BYTES}바이트를 넘습니다`);
      continue;
    }
    const r = parseTheme(themeBytes.toString('utf8'));
    if (!r.ok) {
      problems.push(`${base}/theme.json: 설치 검증을 통과하지 못합니다 (${JSON.stringify(r.problem)})`);
      continue;
    }
    const t = r.theme;
    if (!SOUND_LICENSES.includes(t.license)) problems.push(`${base}/theme.json: 라이선스 ${t.license}은(는) 허용되지 않습니다 (${SOUND_LICENSES.join(', ')})`);
    if (FORBIDDEN_WORDING.test(t.name)) problems.push(`${base}/theme.json: name에 권유·보장으로 읽힐 수 있는 표현이 있습니다 ("${t.name}")`);
    if (!(await readFile(join(root, base, 'LICENSE.md')).then((b) => b.length > 0, () => false))) {
      problems.push(`${base}: LICENSE.md(출처·라이선스·가공 방법)가 없습니다`);
    }
    const sounds: ThemeEntry['sounds'] = {};
    for (const kind of SOUND_KINDS) {
      const s = t.sounds[kind];
      const parts = localThemePath(s.url);
      if (!parts) {
        problems.push(`${base}/theme.json: sounds.${kind}.url은 폴더 안의 상대 경로여야 합니다 ("${s.url}")`);
        continue;
      }
      const wav = await readFile(join(root, base, ...parts)).catch(() => undefined);
      if (!wav) {
        problems.push(`${base}: sounds.${kind}의 파일(${s.url})이 없습니다`);
        continue;
      }
      const info = inspectWav(wav);
      if (!info.ok) {
        problems.push(`${base}/${s.url}: 소리 검증을 통과하지 못합니다 (${info.reason})`);
        continue;
      }
      const hash = sha256Hex(wav);
      if (hash !== s.sha256) problems.push(`${base}/theme.json: sounds.${kind}.sha256이 파일과 다릅니다 (실제 ${hash})`);
      sounds[kind] = { file: `${base}/${parts.join('/')}`, sha256: hash, bytes: wav.length, ms: Math.round(info.info.durationMs) };
    }
    themes.push({ slug: dir, name: t.name, version: t.version, license: t.license, file: `${base}/theme.json`, sha256: sha256Hex(themeBytes), bytes: themeBytes.length, sounds });
  }

  const dup = [...presets.map((p) => p.slug), ...themes.map((t) => t.slug)].filter((s, i, a) => a.indexOf(s) !== i);
  for (const s of new Set(dup)) problems.push(`슬러그 ${s}이(가) 중복됩니다`);
  return { index: { schemaVersion: INDEX_SCHEMA_VERSION, presets, themes }, problems };
}

/** index.json에 저장하는 형태: 들여쓰기 2칸, LF, 끝에 줄바꿈 */
export const serializeIndex = (index: GalleryIndex): string => JSON.stringify(index, null, 2) + '\n';
