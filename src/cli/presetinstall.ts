import { resolve } from 'node:path';
import { BlertError } from '../shared/errors.js';
import { safeOrigin } from '../shared/download.js';
import { sha256Hex } from '../shared/wav.js';
import { EXTERNAL_PRESET_LIMITS, countByType, needsKey, parseExternalPreset, type ExternalPreset } from '../presets/index.js';
import { t } from '../i18n/index.js';
import { SHA256, checkHash, fetchBytes, isUrl, readLocal } from './fetch.js';
import { describeRule } from './format.js';
import { askYesNo } from './init.js';
import type { Deps } from './types.js';

/** 요약에 규칙을 이만큼까지 한 줄씩 보여 준다 (나머지는 개수만) */
const SUMMARY_RULES = 10;

/** 슬러그 형식(`[a-z0-9-]+`)이면 내장 프리셋 이름이고, 아니면 파일 경로 또는 주소다 (D-105) */
export const isBuiltinName = (arg: string): boolean => /^[a-z0-9-]+$/.test(arg.toLowerCase());

function summarize(p: ExternalPreset, origin: string, sha: string): string[] {
  const lines = [
    t('preset.ext.summary', {
      name: p.name,
      slug: p.slug,
      version: p.version,
      origin,
      license: p.license,
      count: p.rules.length,
      types: Object.entries(countByType(p.rules)).map(([k, n]) => `${k} ${n}`).join(', '),
      sha,
    }),
  ];
  if (p.author) lines.push(t('preset.ext.author', { author: p.author }));
  if (p.description) lines.push(t('preset.ext.description', { description: p.description }));
  for (const r of p.rules.slice(0, SUMMARY_RULES)) lines.push(t('preset.ext.ruleLine', { summary: describeRule(r) }));
  if (p.rules.length > SUMMARY_RULES) lines.push(t('preset.ext.more', { n: p.rules.length - SUMMARY_RULES }));
  const keyed = p.rules.filter(needsKey).length;
  if (keyed > 0) lines.push(t('preset.ext.needsKey', { n: keyed }));
  return lines;
}

/**
 * `blert preset install <파일|https주소> [--sha256 <해시>]` (FR-PRE-03, D-77~D-79, D-101~D-109).
 * 검증이 모두 끝난 뒤에만 규칙을 추가한다. 주소 방식만 y/N 동의(기본 No)를 받는다 (D-106).
 */
export async function presetInstallExternal(deps: Deps, source: string, sha256: string | undefined): Promise<number> {
  const { io, presets } = deps;
  if (sha256 !== undefined && !SHA256.test(sha256)) throw new BlertError('err.soundShaFormat');

  const remote = isUrl(source);
  const maxBytes = EXTERNAL_PRESET_LIMITS.maxBytes;
  const bytes = remote ? (await fetchBytes(deps, source, maxBytes)).bytes : await readLocal(resolve(source), maxBytes, 'err.presetFileRead');
  const actual = sha256Hex(bytes);
  checkHash(actual, sha256, 'err.presetHash');

  const parsed = parseExternalPreset(new TextDecoder().decode(bytes));
  if (!parsed.ok) {
    const p = parsed.problem;
    throw p.kind === 'json'
      ? new BlertError('err.presetFileJson')
      : p.kind === 'schema'
        ? new BlertError('err.presetFileSchema', { version: p.version })
        : p.kind === 'slug'
          ? new BlertError('err.presetFileSlug', { value: p.value })
          : new BlertError('err.presetFileField', { field: p.field, max: EXTERNAL_PRESET_LIMITS.maxRules });
  }
  const preset = parsed.value;

  const conflict = await presets.slugConflict(preset.slug);
  if (conflict) throw new BlertError(conflict === 'builtin' ? 'err.presetBuiltinName' : 'err.presetInstalled', { slug: preset.slug });

  const origin = remote ? (safeOrigin(source) ?? 'url') : 'file';
  for (const line of summarize(preset, origin, actual)) io.out(line);
  if (remote && !(await askYesNo(io, t('preset.ext.ask'), false))) throw new BlertError('err.presetDeclined', { slug: preset.slug });

  const count = await presets.installExternal(preset, { source: origin, sha256: actual });
  io.out(t('preset.install.done', { slug: preset.slug, name: preset.name, count }));
  return 0;
}
