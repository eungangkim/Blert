import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type SoundInstall } from '../../src/store/index.js';
import { makeWav } from '../shared/wavfile.js';
import { sha256Hex } from '../../src/shared/wav.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blert-sound-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const item = (kind: SoundInstall['kind'], ms = 200, source = 'file'): SoundInstall => {
  const bytes = makeWav({ ms });
  return { kind, bytes, source, sha256: sha256Hex(bytes), durationMs: ms };
};
const files = async (): Promise<string[]> => readdir(join(dir, 'sounds')).catch(() => []);

describe('사용자 소리 저장', () => {
  it('AC-73 설치하면 sounds/에 <종류>-<해시12>.wav로 저장하고 설정에 기록한다', async () => {
    const s = new Store(dir);
    const it1 = item('up');
    await s.installSounds([it1]);
    const name = `up-${it1.sha256.slice(0, 12)}.wav`;
    expect(await files()).toEqual([name]);
    expect(new Uint8Array(await readFile(join(dir, 'sounds', name)))).toEqual(it1.bytes);
    expect((await s.loadConfig()).soundOverrides?.up).toEqual({ file: name, source: 'file', sha256: it1.sha256, durationMs: 200 });
    expect(await s.userSoundPath('up')).toBe(join(dir, 'sounds', name));
    expect(await s.userSoundPath('down')).toBeUndefined();
  });

  it('AC-73 schemaVersion은 올리지 않는다 (D-100)', async () => {
    const s = new Store(dir);
    await s.installSounds([item('up')]);
    expect((await s.loadConfig()).schemaVersion).toBe(1);
  });

  it('AC-73 같은 칸을 다시 설치하면 이전 파일은 설정을 바꾼 뒤 지운다', async () => {
    const s = new Store(dir);
    await s.installSounds([item('up', 200)]);
    const second = item('up', 300);
    await s.installSounds([second]);
    expect(await files()).toEqual([`up-${second.sha256.slice(0, 12)}.wav`]);
  });

  it('AC-79 reset은 지정한 칸만 되돌리고 파일을 지운다', async () => {
    const s = new Store(dir);
    await s.installSounds([item('up'), item('down', 250)]);
    expect(await s.resetSounds(['up'])).toEqual(['up']);
    const c = await s.loadConfig();
    expect(c.soundOverrides?.up).toBeUndefined();
    expect(c.soundOverrides?.down).toBeDefined();
    expect((await files()).length).toBe(1);
  });

  it('AC-79 reset all은 soundOverrides 항목을 없애고 등록이 없으면 아무것도 하지 않는다', async () => {
    const s = new Store(dir);
    expect(await s.resetSounds('all')).toEqual([]);
    await s.installSounds([item('up'), item('warn', 250)]);
    expect((await s.resetSounds('all')).sort()).toEqual(['up', 'warn']);
    expect((await s.loadConfig()).soundOverrides).toBeUndefined();
    expect(await files()).toEqual([]);
  });

  it('AC-78 설정 갱신이 실패하면 새로 쓴 파일도 지운다 (원복)', async () => {
    const s = new Store(dir);
    await mkdir(join(dir, 'config.json'), { recursive: true }); // 설정 읽기·쓰기가 실패하게 만든다
    await expect(s.installSounds([item('up'), item('down', 250)])).rejects.toThrow();
    expect(await files()).toEqual([]);
  });

  it('AC-80 설정에 적힌 파일 이름이 sounds/ 밖을 가리키면 무시한다', async () => {
    const s = new Store(dir);
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ schemaVersion: 1, soundEnabled: true, language: 'ko', runMode: 'foreground', disclaimerAccepted: false, presets: [], soundOverrides: { up: { file: '../../evil.wav', source: 'file', sha256: 'x', durationMs: 1 } } }),
    );
    expect(await s.userSoundPath('up')).toBeUndefined();
  });

  it('AC-73 다른 설정 항목은 소리 설치 후에도 보존된다', async () => {
    const s = new Store(dir);
    await s.updateConfig((c) => {
      c.soundEnabled = false;
      c.keyRef = 'ref';
    });
    await s.installSounds([item('up')]);
    expect(await s.loadConfig()).toMatchObject({ soundEnabled: false, keyRef: 'ref' });
  });
});
