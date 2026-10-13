import { dirname, join, resolve } from 'node:path';
import { BlertError } from '../shared/errors.js';
import { safeOrigin } from '../shared/download.js';
import { SOUND_KINDS, THEME_MAX_BYTES, localThemePath, parseTheme, type Theme } from '../shared/theme.js';
import type { SoundKind } from '../shared/types.js';
import { WAV_LIMITS, inspectWav, sha256Hex, type WavInfo } from '../shared/wav.js';
import type { SoundInstall } from '../store/index.js';
import { t } from '../i18n/index.js';
import { SHA256, checkHash, fetchBytes, isUrl, readLocal } from './fetch.js';
import { askYesNo } from './init.js';
import type { Deps } from './types.js';

const seconds = (ms: number): string => (ms / 1000).toFixed(2);

interface Loaded {
  bytes: Uint8Array;
  sha256: string;
  info: WavInfo;
  /** 설정에 기록할 출처: 주소는 호스트+경로(쿼리 제거), 로컬 파일은 'file' (D-97) */
  source: string;
}

function inspect(bytes: Uint8Array): WavInfo {
  const r = inspectWav(bytes);
  if (!r.ok) throw new BlertError(`err.soundInvalid.${r.reason}`, { detail: r.detail ?? '' });
  return r.info;
}

type Where = { url: string } | { path: string };

async function loadSound(deps: Deps, where: Where, expectedSha: string | undefined): Promise<Loaded> {
  const got = 'url' in where ? await fetchBytes(deps, where.url, WAV_LIMITS.maxBytes) : { bytes: await readLocal(where.path, WAV_LIMITS.maxBytes), sha256: '' };
  const sha256 = got.sha256 || sha256Hex(got.bytes);
  checkHash(sha256, expectedSha);
  return { bytes: got.bytes, sha256, info: inspect(got.bytes), source: 'url' in where ? (safeOrigin(where.url) ?? 'url') : 'file' };
}

const toInstall = (kind: SoundKind, l: Loaded): SoundInstall => ({ kind, bytes: l.bytes, source: l.source, sha256: l.sha256, durationMs: l.info.durationMs });

/** `blert sound set <종류> <파일|주소> [--sha256 <해시>]` (D-82) */
export async function soundSet(deps: Deps, kind: SoundKind, source: string, sha256: string | undefined): Promise<number> {
  const { io, store } = deps;
  if (sha256 !== undefined && !SHA256.test(sha256)) throw new BlertError('err.soundShaFormat');
  const loaded = isUrl(source) ? await loadSound(deps, { url: source }, sha256) : await loadSound(deps, { path: resolve(source) }, sha256);

  if (isUrl(source)) {
    // 주소 방식은 설치 전에 출처·크기·길이·해시를 보여 주고 동의(기본 No)를 받는다 (D-78)
    io.out(t('sound.set.summary', { kind, origin: loaded.source, kb: (loaded.bytes.length / 1024).toFixed(1), sec: seconds(loaded.info.durationMs), sha: loaded.sha256 }));
    if (!(await askYesNo(io, t('sound.set.ask'), false))) throw new BlertError('err.soundDeclined', { kind });
  }
  await store.installSounds([toInstall(kind, loaded)]);
  io.out(t('sound.set.done', { kind, sec: seconds(loaded.info.durationMs) }));
  return 0;
}

/** `blert sound theme <파일|주소>` (D-83, D-94): 4종이 모두 통과할 때만 적용한다 */
export async function soundTheme(deps: Deps, source: string): Promise<number> {
  const { io, store } = deps;
  const remote = isUrl(source);
  const raw = remote ? (await fetchBytes(deps, source, THEME_MAX_BYTES)).bytes : await readLocal(resolve(source), THEME_MAX_BYTES);
  const parsed = parseTheme(new TextDecoder().decode(raw));
  if (!parsed.ok) {
    const p = parsed.problem;
    throw p.kind === 'json'
      ? new BlertError('err.themeJson')
      : p.kind === 'schema'
        ? new BlertError('err.themeSchema', { version: String(p.version ?? '') })
        : new BlertError('err.themeField', { field: p.field });
  }
  const theme: Theme = parsed.theme;
  const targets = new Map<SoundKind, Where>();
  for (const k of SOUND_KINDS) targets.set(k, themeTarget(source, remote, k, theme.sounds[k].url));

  if (remote) {
    // 설치 전에 관련된 모든 호스트를 보여 준다 (D-94)
    const hosts = [...new Set([source, ...[...targets.values()].map((w) => ('url' in w ? w.url : ''))].filter(Boolean).map((u) => new URL(u).hostname))];
    io.out(t('sound.theme.summary', { name: theme.name, version: theme.version, license: theme.license, hosts: hosts.join(', ') }));
    if (!(await askYesNo(io, t('sound.theme.ask'), false))) throw new BlertError('err.themeDeclined', { name: theme.name });
  }

  const installs: SoundInstall[] = [];
  for (const k of SOUND_KINDS) {
    try {
      installs.push(toInstall(k, await loadSound(deps, targets.get(k)!, theme.sounds[k].sha256)));
    } catch (e) {
      if (!(e instanceof BlertError)) throw e;
      throw new BlertError('err.themeSound', { kind: k, reason: t(e.messageKey, e.params) }, e.exitCode);
    }
  }
  await store.installSounds(installs);
  io.out(t('sound.theme.done', { name: theme.name, version: theme.version }));
  return 0;
}

/** 테마 안의 소리 위치를 실제 주소·경로로 바꾼다. 로컬 테마는 테마 폴더 밖을 가리킬 수 없다 (D-94) */
function themeTarget(themeSource: string, remote: boolean, kind: SoundKind, rel: string): Where {
  if (remote) {
    try {
      return { url: new URL(rel, themeSource).href };
    } catch {
      throw new BlertError('err.themePath', { kind, path: rel });
    }
  }
  const parts = localThemePath(rel);
  if (!parts) throw new BlertError('err.themePath', { kind, path: rel });
  return { path: join(dirname(resolve(themeSource)), ...parts) };
}

/** `blert sound reset [종류|all]` (D-83) */
export async function soundReset(deps: Deps, kinds: SoundKind[] | 'all'): Promise<number> {
  const cleared = await deps.store.resetSounds(kinds);
  deps.io.out(cleared.length ? t('sound.reset.done', { kinds: cleared.join(', ') }) : t('sound.reset.none'));
  return 0;
}

/** `blert sound list` (D-99) */
export async function soundList(deps: Deps): Promise<number> {
  const overrides = (await deps.store.loadConfig()).soundOverrides ?? {};
  deps.io.out(t('sound.list.title'));
  for (const kind of SOUND_KINDS) {
    const o = overrides[kind];
    deps.io.out(o ? t('sound.list.user', { kind, source: o.source, sha: o.sha256.slice(0, 8), sec: seconds(o.durationMs) }) : t('sound.list.bundled', { kind }));
  }
  return 0;
}
