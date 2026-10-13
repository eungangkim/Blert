import type { SoundKind } from './types.js';

export const SOUND_KINDS: readonly SoundKind[] = ['up', 'down', 'account', 'warn'];
export const THEME_SCHEMA_VERSION = 1;
/** 테마 파일(JSON) 크기 상한 */
export const THEME_MAX_BYTES = 64 * 1024;

export interface ThemeSound {
  /** 소리 파일 위치: 로컬 테마는 테마 폴더 안의 상대 경로, 주소 테마는 테마 주소 기준으로 해석한다 (D-94) */
  url: string;
  sha256: string;
}
export interface Theme {
  schemaVersion: number;
  name: string;
  version: string;
  license: string;
  sounds: Record<SoundKind, ThemeSound>;
}

export type ThemeProblem =
  | { kind: 'json' }
  | { kind: 'schema'; version: unknown }
  /** 필수 항목이 없거나 형식이 틀림. field는 `sounds.up.sha256`처럼 위치 */
  | { kind: 'field'; field: string };

const SHA256 = /^[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;

/** 테마 파일 내용을 검사한다. 해시는 필수이고 4종이 모두 있어야 한다 (D-94). 모르는 항목은 무시한다. */
export function parseTheme(raw: string): { ok: true; theme: Theme } | { ok: false; problem: ThemeProblem } {
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return { ok: false, problem: { kind: 'json' } };
  }
  if (!isObj(d)) return { ok: false, problem: { kind: 'json' } };
  if (d.schemaVersion !== THEME_SCHEMA_VERSION) return { ok: false, problem: { kind: 'schema', version: d.schemaVersion } };
  for (const f of ['name', 'version', 'license'] as const) {
    if (!text(d[f])) return { ok: false, problem: { kind: 'field', field: f } };
  }
  if (!isObj(d.sounds)) return { ok: false, problem: { kind: 'field', field: 'sounds' } };
  const sounds = {} as Record<SoundKind, ThemeSound>;
  for (const k of SOUND_KINDS) {
    const s = d.sounds[k];
    if (!isObj(s) || !text(s.url, 2000)) return { ok: false, problem: { kind: 'field', field: `sounds.${k}.url` } };
    if (typeof s.sha256 !== 'string' || !SHA256.test(s.sha256.toLowerCase())) return { ok: false, problem: { kind: 'field', field: `sounds.${k}.sha256` } };
    sounds[k] = { url: s.url, sha256: s.sha256.toLowerCase() };
  }
  return { ok: true, theme: { schemaVersion: THEME_SCHEMA_VERSION, name: d.name as string, version: d.version as string, license: d.license as string, sounds } };
}

/**
 * 로컬 테마의 소리 경로가 테마 폴더 안의 상대 경로인가. 절대 경로·드라이브·`..`·주소·역슬래시는 거부한다 (D-94).
 * 안전하면 슬래시로 나눈 조각을 돌려준다.
 */
export function localThemePath(rel: string): string[] | undefined {
  if (rel.includes('\\') || rel.includes(':') || rel.startsWith('/') || rel.includes('\0')) return undefined;
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.includes('..')) return undefined;
  return parts;
}
