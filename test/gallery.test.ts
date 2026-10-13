import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIndex, serializeIndex } from '../gallery/scripts/lib.js';
import { sha256Hex } from '../src/shared/wav.js';
import { presetJson } from './presets/extfixture.js';
import { makeWav } from './shared/wavfile.js';

// 갤러리 원본 검사 (D-85, D-133). 수용 기준 번호가 없는 항목이라 결정 번호로 시작한다.
const GALLERY = join(dirname(fileURLToPath(import.meta.url)), '..', 'gallery');
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'blert-gallery-'));
  dirs.push(root);
  await mkdir(join(root, 'presets'), { recursive: true });
  await mkdir(join(root, 'sounds'), { recursive: true });
  return root;
}
const putPreset = (root: string, file: string, over: Record<string, unknown> = {}): Promise<void> =>
  writeFile(join(root, 'presets', file), JSON.stringify(presetJson({ slug: 'good-one', ...over })));

async function putTheme(root: string, dir = 'quiet-pack', over: { license?: string; hash?: string; licenseFile?: boolean } = {}): Promise<void> {
  const d = join(root, 'sounds', dir);
  await mkdir(d, { recursive: true });
  const sounds: Record<string, unknown> = {};
  for (const k of ['up', 'down', 'account', 'warn']) {
    const wav = makeWav({ ms: 200 });
    await writeFile(join(d, `${k}.wav`), wav);
    sounds[k] = { url: `${k}.wav`, sha256: k === 'up' && over.hash ? over.hash : sha256Hex(wav) };
  }
  await writeFile(join(d, 'theme.json'), JSON.stringify({ schemaVersion: 1, name: 'Quiet pack', version: '1', license: over.license ?? 'CC0-1.0', sounds }));
  if (over.licenseFile !== false) await writeFile(join(d, 'LICENSE.md'), '출처: 직접 제작 / CC0-1.0\n');
}

const problemsOf = async (root: string): Promise<string> => (await buildIndex(root)).problems.join('\n');

describe('갤러리 원본 (D-85, D-133)', () => {
  it('D-133 저장소의 gallery는 모든 검증을 통과하고 index.json이 최신이다', async () => {
    const { index, problems } = await buildIndex(GALLERY);
    expect(problems).toEqual([]);
    expect(index.presets.length).toBeGreaterThanOrEqual(4);
    const committed = await readFile(join(GALLERY, 'index.json'), 'utf8');
    expect(committed).toBe(serializeIndex(index)); // 최신이 아니면 `npm run gallery:build`
    expect(committed).not.toContain('\r');
  });

  it('D-133 index.json의 해시는 실제 파일 내용(바이트)과 같다', async () => {
    const { index } = await buildIndex(GALLERY);
    for (const p of index.presets) expect(sha256Hex(await readFile(join(GALLERY, p.file)))).toBe(p.sha256);
    for (const t of index.themes) {
      expect(sha256Hex(await readFile(join(GALLERY, t.file)))).toBe(t.sha256);
      for (const s of Object.values(t.sounds)) expect(sha256Hex(await readFile(join(GALLERY, s.file)))).toBe(s.sha256);
    }
  });

  it('D-133 갤러리 프리셋은 계정 키가 필요한지 목록에 표시하고, 모두 CC0 또는 MIT다', async () => {
    const { index } = await buildIndex(GALLERY);
    const bySlug = new Map(index.presets.map((p) => [p.slug, p]));
    expect(bySlug.get('liq-guard')?.needsKey).toBe(true);
    expect(bySlug.get('alt-volatility')?.needsKey).toBe(false);
    expect(index.presets.every((p) => ['CC0-1.0', 'MIT'].includes(p.license))).toBe(true);
  });

  it('D-133 정상적인 프리셋과 소리 테마는 목록에 담긴다', async () => {
    const root = await scratch();
    await putPreset(root, 'good-one.json');
    await putTheme(root);
    const { index, problems } = await buildIndex(root);
    expect(problems).toEqual([]);
    expect(index.presets[0]).toMatchObject({ slug: 'good-one', file: 'presets/good-one.json', ruleCount: 3 });
    expect(index.themes[0]).toMatchObject({ slug: 'quiet-pack', file: 'sounds/quiet-pack/theme.json' });
    expect(Object.keys(index.themes[0]!.sounds)).toEqual(['up', 'down', 'account', 'warn']);
  });

  it('D-133 설치 검증을 통과하지 못하는 프리셋은 거부한다', async () => {
    const root = await scratch();
    await putPreset(root, 'good-one.json', { rules: [] });
    expect(await problemsOf(root)).toContain('presets/good-one.json: 설치 검증을 통과하지 못합니다');
  });

  it('D-133 파일 이름이 슬러그와 다르면 거부한다', async () => {
    const root = await scratch();
    await putPreset(root, 'other-name.json');
    expect(await problemsOf(root)).toContain('파일 이름은 슬러그(good-one.json)와 같아야 합니다');
  });

  it('D-133 허용되지 않은 라이선스는 거부한다 (프리셋은 CC0·MIT, 소리는 CC0만)', async () => {
    const root = await scratch();
    await putPreset(root, 'good-one.json', { license: 'GPL-3.0' });
    await putTheme(root, 'quiet-pack', { license: 'MIT' });
    const text = await problemsOf(root);
    expect(text).toContain('라이선스 GPL-3.0');
    expect(text).toContain('라이선스 MIT');
  });

  it('D-133 이름·설명에 매수·매도 권유나 수익 보장으로 읽히는 표현이 있으면 거부한다', async () => {
    for (const bad of ['BTC 매수 타이밍', '수익 보장 알림', 'Buy the dip', 'Profit signals', '추천 종목']) {
      const root = await scratch();
      await putPreset(root, 'good-one.json', { name: bad });
      expect(await problemsOf(root), bad).toContain('권유·보장으로 읽힐 수 있는 표현');
    }
    const root = await scratch();
    await putPreset(root, 'good-one.json', { description: 'Guaranteed profit' });
    expect(await problemsOf(root)).toContain('description');
  });

  it('D-133 소리 테마: 해시 불일치를 거부한다', async () => {
    const root = await scratch();
    await putTheme(root, 'quiet-pack', { hash: 'a'.repeat(64) });
    expect(await problemsOf(root)).toContain('sounds.up.sha256이 파일과 다릅니다');
  });

  it('D-133 소리 테마: LICENSE.md가 없으면 거부한다', async () => {
    const root = await scratch();
    await putTheme(root, 'quiet-pack', { licenseFile: false });
    expect(await problemsOf(root)).toContain('LICENSE.md');
  });

  it('D-133 소리 테마: 폴더 이름이 슬러그 형식이 아니면 거부한다', async () => {
    const root = await scratch();
    await putTheme(root, 'Bad Name');
    expect(await problemsOf(root)).toContain('폴더 이름은 영문 소문자');
  });

  it('D-133 소리 파일이 소리 검증 기준(3초 이하 PCM 등)을 못 지키면 거부한다', async () => {
    const root = await scratch();
    await putTheme(root);
    const long = makeWav({ ms: 4000 });
    const dir = join(root, 'sounds', 'quiet-pack');
    await writeFile(join(dir, 'up.wav'), long);
    const theme = JSON.parse(await readFile(join(dir, 'theme.json'), 'utf8'));
    theme.sounds.up.sha256 = sha256Hex(long);
    await writeFile(join(dir, 'theme.json'), JSON.stringify(theme));
    expect(await problemsOf(root)).toContain('소리 검증을 통과하지 못합니다 (too-long)');
  });

  it('D-133 테마의 소리 경로가 폴더 밖이면 거부한다', async () => {
    const root = await scratch();
    await putTheme(root);
    const dir = join(root, 'sounds', 'quiet-pack');
    const theme = JSON.parse(await readFile(join(dir, 'theme.json'), 'utf8'));
    theme.sounds.up.url = '../escape.wav';
    await writeFile(join(dir, 'theme.json'), JSON.stringify(theme));
    expect(await problemsOf(root)).toContain('폴더 안의 상대 경로여야 합니다');
  });

  it('D-133 프리셋과 테마의 슬러그가 겹치면 거부한다', async () => {
    const root = await scratch();
    await putPreset(root, 'good-one.json');
    await putTheme(root, 'good-one');
    expect(await problemsOf(root)).toContain('슬러그 good-one');
  });
});
