import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeHarness, type Harness } from './helpers.js';
import { sha256Hex } from '../../src/shared/wav.js';
import { makeWav } from '../shared/wavfile.js';

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const KINDS = ['up', 'down', 'account', 'warn'] as const;
const all = (): string => [...h.out, ...h.err].join('\n');
const soundFiles = async (): Promise<string[]> => readdir(join(h.dir, 'sounds')).catch(() => []);
const okDl = (bytes: Uint8Array, url: string) => ({ ok: true as const, bytes, sha256: sha256Hex(bytes), finalUrl: url });

async function writeWav(name: string, ms = 200): Promise<{ path: string; bytes: Uint8Array }> {
  const bytes = makeWav({ ms });
  const path = join(h.dir, name);
  await mkdir(h.dir, { recursive: true });
  await writeFile(path, bytes);
  return { path, bytes };
}

describe('blert sound set (파일)', () => {
  it('AC-73 파일을 등록하면 저장·기록되고 sound test가 사용자 소리를 따른다', async () => {
    h = await makeHarness();
    const { path, bytes } = await writeWav('mine.wav');
    expect(await h.run(`sound set up ${path}`)).toBe(0);
    const o = (await h.deps.store.loadConfig()).soundOverrides?.up;
    expect(o).toMatchObject({ source: 'file', sha256: sha256Hex(bytes), durationMs: 200 });
    expect(await soundFiles()).toEqual([`up-${sha256Hex(bytes).slice(0, 12)}.wav`]);
    expect(await h.deps.store.userSoundPath('up')).toBe(join(h.dir, 'sounds', o!.file));
    expect(await h.run('sound test up')).toBe(0);
    expect(h.calls).toContain('soundTest:up');
  });

  it('AC-75 형식이 틀린 파일은 저장하지 않고 이유와 예시를 안내 (종료 코드 1)', async () => {
    h = await makeHarness();
    const bad = join(h.dir, 'bad.wav');
    await writeFile(bad, 'not a wav at all, definitely');
    expect(await h.run(`sound set up ${bad}`)).toBe(1);
    expect(all()).toContain('WAV 파일이 아닙니다');
    expect(all()).toContain('예:');
    const long = join(h.dir, 'long.wav');
    await writeFile(long, makeWav({ ms: 3500 }));
    expect(await h.run(`sound set up ${long}`)).toBe(1);
    expect(all()).toContain('3초 이하');
    expect(await soundFiles()).toEqual([]);
    expect((await h.deps.store.loadConfig()).soundOverrides).toBeUndefined();
  });

  it('AC-75 없는 파일은 경로 안내와 함께 종료 코드 1', async () => {
    h = await makeHarness();
    expect(await h.run(`sound set up ${join(h.dir, 'nope.wav')}`)).toBe(1);
    expect(all()).toContain('파일을 읽지 못했습니다');
  });

  it('AC-76 --sha256이 다르면 설치하지 않고 해시 불일치를 안내', async () => {
    h = await makeHarness();
    const { path } = await writeWav('mine.wav');
    expect(await h.run(`sound set up ${path} --sha256 ${'0'.repeat(64)}`)).toBe(1);
    expect(all()).toContain('해시가 지정한 값과 다릅니다');
    expect(await soundFiles()).toEqual([]);
  });

  it('AC-76 --sha256이 맞으면 설치하고, 형식이 틀리면 거부한다', async () => {
    h = await makeHarness();
    const { path, bytes } = await writeWav('mine.wav');
    expect(await h.run(`sound set up ${path} --sha256 ${sha256Hex(bytes).toUpperCase()}`)).toBe(0);
    expect(await h.run(`sound set up ${path} --sha256 abc`)).toBe(1);
    expect(all()).toContain('64자리');
  });

  it('AC-73 잘못된 칸·인자는 종료 코드 1과 사용법', async () => {
    h = await makeHarness();
    expect(await h.run('sound set')).toBe(1);
    expect(await h.run('sound set up')).toBe(1);
    expect(await h.run('sound set loud ./a.wav')).toBe(1);
    expect(await h.run('sound test up --sha256 ' + '0'.repeat(64))).toBe(1);
  });
});

describe('blert sound set (주소)', () => {
  const url = 'https://sounds.example.com/pack/up.wav?token=SECRET#frag';

  it('AC-74 출처·크기·길이·해시를 보여 주고 y면 설치한다. 기록에는 쿼리가 없다 (AC-80)', async () => {
    h = await makeHarness(['y']);
    const bytes = makeWav({ ms: 300 });
    h.dl.responses.set(url, okDl(bytes, url));
    expect(await h.run(`sound set up ${url}`)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('sounds.example.com/pack/up.wav');
    expect(text).toContain(sha256Hex(bytes));
    expect(text).toContain('0.30초');
    expect(text).not.toContain('SECRET');
    expect(h.asked[0]).toContain('(y/N)');
    const o = (await h.deps.store.loadConfig()).soundOverrides?.up;
    expect(o?.source).toBe('sounds.example.com/pack/up.wav');
    expect(JSON.stringify(await h.deps.store.loadConfig())).not.toContain('SECRET');
    expect(await soundFiles()).toEqual([`up-${sha256Hex(bytes).slice(0, 12)}.wav`]);
  });

  it('AC-74 n이면 설치하지 않는다 (기본 No)', async () => {
    h = await makeHarness(['']);
    h.dl.responses.set(url, okDl(makeWav(), url));
    expect(await h.run(`sound set up ${url}`)).toBe(1);
    expect(all()).toContain('설치하지 않았습니다');
    expect(await soundFiles()).toEqual([]);
  });

  it('AC-76 주소 방식에서도 해시가 다르면 동의를 묻기 전에 거부한다', async () => {
    h = await makeHarness(['y']);
    h.dl.responses.set(url, okDl(makeWav(), url));
    expect(await h.run(`sound set up ${url} --sha256 ${'a'.repeat(64)}`)).toBe(1);
    expect(h.asked).toEqual([]);
    expect(await soundFiles()).toEqual([]);
  });

  it('AC-77 내려받기 실패(http·리다이렉트·크기·시간)는 설치 없이 안내하고, 상한은 512KB로 요청한다', async () => {
    h = await makeHarness();
    const cases: [string, string, number][] = [
      ['insecure', 'https 주소만', 1],
      ['redirect', '다른 주소로', 1],
      ['too-large', '너무 커서', 1],
      ['timeout', '10초 안에', 3],
      ['network', '내려받지 못했습니다', 3],
    ];
    for (const [reason, text, code] of cases) {
      h.out.length = 0;
      h.err.length = 0;
      h.dl.responses.set(url, { ok: false, reason: reason as never });
      expect(await h.run(`sound set up ${url}`), reason).toBe(code);
      expect(all(), reason).toContain(text);
    }
    expect(h.dl.calls.every((c) => c.maxBytes === 512 * 1024)).toBe(true);
    expect(await soundFiles()).toEqual([]);
  });

  it('AC-77 파일 방식과 다른 명령은 네트워크 요청을 하지 않는다', async () => {
    h = await makeHarness();
    const { path } = await writeWav('mine.wav');
    await h.run(`sound set up ${path}`);
    await h.run('sound list');
    await h.run('sound reset all');
    await h.run('sound on');
    expect(h.dl.calls).toEqual([]);
  });

  it('AC-80 설치되는 파일명은 blert가 정한다 (주소의 이름·경로 문자를 쓰지 않음)', async () => {
    h = await makeHarness(['y']);
    const evil = 'https://x.example.com/..%2F..%2Fevil.wav';
    const bytes = makeWav();
    h.dl.responses.set(evil, okDl(bytes, evil));
    expect(await h.run(`sound set warn ${evil}`)).toBe(0);
    expect(await soundFiles()).toEqual([`warn-${sha256Hex(bytes).slice(0, 12)}.wav`]);
  });
});

describe('blert sound theme', () => {
  async function writeTheme(sounds: Partial<Record<(typeof KINDS)[number], { url: string; sha256: string }>>, extra: Record<string, unknown> = {}): Promise<string> {
    const dir = join(h.dir, 'theme');
    await mkdir(dir, { recursive: true });
    const theme = { schemaVersion: 1, name: '시험 테마', version: '1.0.0', license: 'CC0-1.0', sounds, ...extra };
    const path = join(dir, 'theme.json');
    await writeFile(path, JSON.stringify(theme));
    return path;
  }
  async function localSounds(): Promise<Record<(typeof KINDS)[number], { url: string; sha256: string }>> {
    const out = {} as Record<(typeof KINDS)[number], { url: string; sha256: string }>;
    for (const [i, k] of KINDS.entries()) {
      const bytes = makeWav({ ms: 150 + i * 50 });
      await mkdir(join(h.dir, 'theme'), { recursive: true });
      await writeFile(join(h.dir, 'theme', `${k}.wav`), bytes);
      out[k] = { url: `${k}.wav`, sha256: sha256Hex(bytes) };
    }
    return out;
  }

  it('AC-78 로컬 테마: 4종이 모두 통과하면 일괄 적용', async () => {
    h = await makeHarness();
    const path = await writeTheme(await localSounds());
    expect(await h.run(`sound theme ${path}`)).toBe(0);
    const o = (await h.deps.store.loadConfig()).soundOverrides!;
    expect(Object.keys(o).sort()).toEqual([...KINDS].sort());
    expect((await soundFiles()).length).toBe(4);
    expect(h.asked).toEqual([]); // 네트워크가 없는 로컬 테마는 동의 질문이 없다
    expect(h.dl.calls).toEqual([]);
  });

  it('AC-78 하나라도 실패하면 아무것도 바꾸지 않는다 (해시 불일치)', async () => {
    h = await makeHarness();
    const sounds = await localSounds();
    sounds.warn.sha256 = '0'.repeat(64);
    expect(await h.run(`sound theme ${await writeTheme(sounds)}`)).toBe(1);
    expect(all()).toContain("'warn'");
    expect(all()).toContain('아무것도 바꾸지 않았습니다');
    expect(await soundFiles()).toEqual([]);
    expect((await h.deps.store.loadConfig()).soundOverrides).toBeUndefined();
  });

  it('AC-78 기존 소리는 테마가 실패해도 그대로다', async () => {
    h = await makeHarness();
    const mine = await writeWav('mine.wav');
    await h.run(`sound set up ${mine.path}`);
    const before = (await h.deps.store.loadConfig()).soundOverrides;
    const sounds = await localSounds();
    await writeFile(join(h.dir, 'theme', 'down.wav'), 'broken');
    expect(await h.run(`sound theme ${await writeTheme(sounds)}`)).toBe(1);
    expect((await h.deps.store.loadConfig()).soundOverrides).toEqual(before);
    expect((await soundFiles()).length).toBe(1);
  });

  it('AC-78 소리 4종 중 빠진 것·해시가 없는 것·옛 버전은 거부', async () => {
    h = await makeHarness();
    const sounds = await localSounds();
    const { warn: _w, ...three } = sounds;
    expect(await h.run(`sound theme ${await writeTheme(three)}`)).toBe(1);
    expect(all()).toContain('sounds.warn.url');
    h.err.length = 0;
    expect(await h.run(`sound theme ${await writeTheme({ ...sounds, up: { url: 'up.wav' } as never })}`)).toBe(1);
    expect(all()).toContain('sounds.up.sha256');
    h.err.length = 0;
    expect(await h.run(`sound theme ${await writeTheme(sounds, { schemaVersion: 99 })}`)).toBe(1);
    expect(all()).toContain('지원하지 않는 테마 버전');
  });

  it('AC-78 로컬 테마는 폴더 밖·절대 경로·주소를 가리킬 수 없다 (D-94)', async () => {
    h = await makeHarness();
    for (const bad of ['../mine.wav', '/etc/passwd', 'C:/Windows/a.wav', 'https://evil.example.com/a.wav', 'a\\b.wav']) {
      h.err.length = 0;
      const sounds = await localSounds();
      sounds.up = { url: bad, sha256: sounds.up.sha256 };
      expect(await h.run(`sound theme ${await writeTheme(sounds)}`), bad).toBe(1);
      expect(all(), bad).toContain('위치가 올바르지 않습니다');
    }
    expect(h.dl.calls).toEqual([]);
  });

  it('AC-78 주소 테마: 호스트를 모두 보여 주고 y면 4종을 받아 설치한다 (상대 주소는 테마 주소 기준)', async () => {
    h = await makeHarness(['y']);
    const base = 'https://themes.example.com/pack/theme.json';
    const sounds: Record<string, { url: string; sha256: string }> = {};
    for (const [i, k] of KINDS.entries()) {
      const bytes = makeWav({ ms: 150 + i * 50 });
      const url = k === 'warn' ? 'https://cdn.example.org/w.wav' : `${k}.wav`;
      sounds[k] = { url, sha256: sha256Hex(bytes) };
      const full = new URL(url, base).href;
      h.dl.responses.set(full, okDl(bytes, full));
    }
    const themeBytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, name: '원격', version: '2.0.0', license: 'CC0-1.0', sounds }));
    h.dl.responses.set(base, okDl(themeBytes, base));
    expect(await h.run(`sound theme ${base}`)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('themes.example.com');
    expect(text).toContain('cdn.example.org');
    expect(h.asked[0]).toContain('(y/N)');
    expect(h.dl.calls.map((c) => c.url)).toEqual([base, 'https://themes.example.com/pack/up.wav', 'https://themes.example.com/pack/down.wav', 'https://themes.example.com/pack/account.wav', 'https://cdn.example.org/w.wav']);
    expect(Object.keys((await h.deps.store.loadConfig()).soundOverrides!)).toHaveLength(4);
  });

  it('AC-78 주소 테마에서 n이면 소리를 내려받지도 않는다', async () => {
    h = await makeHarness(['n']);
    const base = 'https://themes.example.com/theme.json';
    const sounds = Object.fromEntries(KINDS.map((k) => [k, { url: `${k}.wav`, sha256: 'a'.repeat(64) }]));
    const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, name: 'x', version: '1', license: 'MIT', sounds }));
    h.dl.responses.set(base, okDl(bytes, base));
    expect(await h.run(`sound theme ${base}`)).toBe(1);
    expect(h.dl.calls).toHaveLength(1);
    expect(await soundFiles()).toEqual([]);
  });
});

describe('blert sound reset / list', () => {
  it('AC-79 reset up은 그 칸만, reset all은 전부 번들 소리로 되돌리고 파일을 지운다', async () => {
    h = await makeHarness();
    const a = await writeWav('a.wav', 200);
    const b = await writeWav('b.wav', 300);
    await h.run(`sound set up ${a.path}`);
    await h.run(`sound set down ${b.path}`);
    expect(await h.run('sound reset up')).toBe(0);
    expect((await h.deps.store.loadConfig()).soundOverrides?.up).toBeUndefined();
    expect((await soundFiles()).length).toBe(1);
    expect(await h.run('sound reset all')).toBe(0);
    expect(await soundFiles()).toEqual([]);
    expect((await h.deps.store.loadConfig()).soundOverrides).toBeUndefined();
  });

  it('AC-79 등록이 없으면 되돌릴 것이 없다고 알린다', async () => {
    h = await makeHarness();
    expect(await h.run('sound reset')).toBe(0);
    expect(all()).toContain('되돌릴 등록 소리가 없습니다');
    expect(await h.run('sound reset loud')).toBe(1);
  });

  it('AC-83 list는 4칸의 번들/사용자 소리, 출처, 해시 앞 8자리, 길이를 보여 준다', async () => {
    h = await makeHarness();
    expect(await h.run('sound list')).toBe(0);
    for (const k of KINDS) expect(h.out.join('\n')).toContain(`${k}: 번들 소리`);
    const { path, bytes } = await writeWav('a.wav', 250);
    await h.run(`sound set down ${path}`);
    h.out.length = 0;
    await h.run('sound list');
    const text = h.out.join('\n');
    expect(text).toContain(`down: 내 소리 — 출처 file, sha256 ${sha256Hex(bytes).slice(0, 8)}…, 0.25초`);
    expect(text).toContain('up: 번들 소리');
  });
});
