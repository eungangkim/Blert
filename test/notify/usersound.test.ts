import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { SoundAdapter } from '../../src/notify/adapters.js';
import { createNotifier } from '../../src/notify/index.js';
import type { Alert } from '../../src/shared/types.js';
import { makeWav } from '../shared/wavfile.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blert-usersound-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(userSound: (k: string) => Promise<string | undefined>, failUser = false) {
  const played: string[] = [];
  const warnings: string[] = [];
  const sound = new SoundAdapter({
    enabled: () => true,
    dir: '/bundled',
    platform: 'darwin',
    userSound: userSound as never,
    warn: (t) => warnings.push(t),
    run: async (_c, args) => {
      played.push(args[0]!);
      if (failUser && args[0]!.startsWith(dir)) throw new Error('player failed');
    },
  });
  return { sound, played, warnings };
}

const alert = (kind: Alert['kind']): Alert => ({ ruleId: 1, kind, titleKey: 'alert.test.title', params: { kind }, firedAt: '2026-10-13T00:00:00.000Z' });

describe('사용자 소리 재생 (D-95, D-98)', () => {
  it('AC-73 등록된 사용자 소리를 번들보다 먼저 재생한다', async () => {
    const file = join(dir, 'up-abc.wav');
    await writeFile(file, makeWav());
    const { sound, played, warnings } = setup(async (k) => (k === 'up' ? file : undefined));
    await sound.play('up');
    await sound.play('down');
    expect(played).toEqual([file, join('/bundled', 'down.wav')]);
    expect(warnings).toEqual([]);
  });

  it('AC-81 파일이 없으면 번들 소리로 재생하고 경고는 종류별 1회만', async () => {
    const { sound, played, warnings } = setup(async () => join(dir, 'gone.wav'));
    await sound.send([alert('up')]);
    await sound.send([alert('up')]);
    await sound.send([alert('down')]);
    expect(played.map((p) => basename(p))).toEqual(['up.wav', 'up.wav', 'down.wav']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('up');
    expect(warnings[0]).toContain('blert sound reset up');
  });

  it('AC-81 손상된 파일(WAV가 아님)도 번들 소리로 대신한다', async () => {
    const file = join(dir, 'bad.wav');
    await writeFile(file, 'not a wav');
    const { sound, played, warnings } = setup(async () => file);
    await sound.play('warn');
    expect(played).toEqual([join('/bundled', 'warn.wav')]);
    expect(warnings).toHaveLength(1);
  });

  it('AC-81 재생기가 사용자 소리를 거부해도 번들 소리로 대신한다', async () => {
    const file = join(dir, 'ok.wav');
    await writeFile(file, makeWav());
    const { sound, played, warnings } = setup(async () => file, true);
    await sound.play('up');
    expect(played).toEqual([file, join('/bundled', 'up.wav')]);
    expect(warnings).toHaveLength(1);
  });

  it('AC-81 설정을 읽지 못해도 번들 소리로 알림은 정상', async () => {
    const { sound, played } = setup(async () => {
      throw new Error('config unreadable');
    });
    await sound.play('account');
    expect(played).toEqual([join('/bundled', 'account.wav')]);
  });

  it('AC-82 재생할 때마다 등록을 다시 읽어 재시작 없이 바뀐다', async () => {
    const a = join(dir, 'a.wav');
    const b = join(dir, 'b.wav');
    await writeFile(a, makeWav());
    await writeFile(b, makeWav({ ms: 300 }));
    let current: string | undefined = a;
    const { sound, played } = setup(async () => current);
    await sound.play('up');
    current = b;
    await sound.play('up');
    current = undefined;
    await sound.play('up');
    expect(played).toEqual([a, b, join('/bundled', 'up.wav')]);
  });

  it('AC-82 createNotifier에 연결한 userSound가 sound test에도 적용된다', async () => {
    const file = join(dir, 'w.wav');
    await writeFile(file, makeWav());
    const played: string[] = [];
    const n = createNotifier({
      out: () => {},
      soundEnabled: () => true,
      platform: 'darwin',
      run: async (_c, args) => void played.push(args[0]!),
      userSound: async (k) => (k === 'down' ? file : undefined),
    });
    await n.soundTest('down');
    expect(played).toEqual([file]);
  });
});
