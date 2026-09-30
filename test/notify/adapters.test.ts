import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SOUND_DIR, DesktopAdapter, SoundAdapter, WIN_TOAST_ENCODED, pickSound } from '../../src/notify/adapters.js';
import type { Alert } from '../../src/shared/types.js';

const alert = (extra: Partial<Alert> = {}): Alert => ({
  ruleId: 1, kind: 'up', titleKey: 'alert.price.above.title',
  params: { coin: 'BTC', quote: 'USDT', market: 'spot', target: '70,000', price: '70,012' },
  firedAt: '2026-10-03T00:00:00.000Z', ...extra,
});
const hostile = alert({ params: { coin: `"; $(calc) \`x\` '`, quote: 'USDT', market: 'spot', target: '1', price: '1' } });

describe('DesktopAdapter (FR-NOTI-01)', () => {
  it('Windows: PowerShell 토스트를 인코딩된 스크립트로 실행하고 제목·본문은 환경변수로만 넘긴다', async () => {
    const run = vi.fn(async () => {});
    await new DesktopAdapter('win32', run).send([hostile]);
    const [cmd, args, env] = run.mock.calls[0] as unknown as [string, string[], Record<string, string>];
    expect(cmd).toBe('powershell.exe');
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand', WIN_TOAST_ENCODED]);
    expect(env.BLERT_TITLE).toContain('$(calc)'); // 값 그대로, 스크립트에는 섞이지 않음
    expect(env.BLERT_BODY).toBe('현재 1 USDT · 현물');
    const script = Buffer.from(WIN_TOAST_ENCODED, 'base64').toString('utf16le');
    expect(script).toContain('CreateToastNotifier');
    expect(script).toContain("silent='true'"); // 소리는 blert가 직접 재생
    expect(script).not.toContain('calc');
  });

  it('macOS: osascript에 제목·본문을 별도 인자로 넘긴다', async () => {
    const run = vi.fn(async () => {});
    await new DesktopAdapter('darwin', run).send([hostile]);
    const [cmd, args] = run.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('osascript');
    const sep = args.indexOf('--');
    expect(sep).toBeGreaterThan(0);
    expect(args.slice(sep + 1)).toHaveLength(2); // 제목, 본문
    expect(args[sep + 1]).toContain('$(calc)');
    expect(args.slice(0, sep).join(' ')).not.toContain('calc'); // AppleScript 본문에는 값이 섞이지 않는다
  });

  it('Linux: notify-send에 -- 뒤로 제목·본문을 넘겨 옵션으로 오인되지 않게 한다', async () => {
    const run = vi.fn(async () => {});
    await new DesktopAdapter('linux', run).send([alert({ titleKey: 'alert.test.title', params: { kind: '--x' } })]);
    expect(run.mock.calls[0]).toEqual(['notify-send', ['--app-name=blert', '--', 'blert 테스트 알림', '--x 알림입니다. 이 알림이 보이면 정상입니다.']]);
  });

  it('여러 건이면 순서대로 각각 표시한다', async () => {
    const run = vi.fn(async () => {});
    await new DesktopAdapter('linux', run).send([alert(), alert()]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('일시적인 실행 실패는 한 번 다시 시도하고, 계속 실패하면 던진다', async () => {
    const flaky = vi.fn().mockRejectedValueOnce(new Error('spawn EPERM')).mockResolvedValue(undefined);
    await new DesktopAdapter('win32', flaky).send([alert()]);
    expect(flaky).toHaveBeenCalledTimes(2);

    const broken = vi.fn(async () => {
      throw new Error('ENOENT');
    });
    await expect(new DesktopAdapter('linux', broken).send([alert()])).rejects.toThrow('ENOENT');
    expect(broken).toHaveBeenCalledTimes(2);
  });
});

describe('SoundAdapter (FR-NOTI-02)', () => {
  const opts = (platform: NodeJS.Platform, run: SoundAdapter['play'] extends never ? never : (c: string, a: string[], e?: Record<string, string>) => Promise<void>) => ({
    enabled: () => true, dir: join('/snd'), platform, run,
  });

  it('OS별 기본 재생 도구로 WAV를 재생한다', async () => {
    const win = vi.fn(async () => {});
    await new SoundAdapter(opts('win32', win)).play('up');
    const [cmd, args, env] = win.mock.calls[0] as unknown as [string, string[], Record<string, string>];
    expect(cmd).toBe('powershell.exe');
    expect(args.at(-1)).toContain('System.Media.SoundPlayer');
    expect(env.BLERT_SOUND!.replace(/\\/g, '/')).toBe('/snd/up.wav');

    const mac = vi.fn(async () => {});
    await new SoundAdapter(opts('darwin', mac)).play('warn');
    expect(mac.mock.calls[0]).toEqual(['afplay', [join('/snd', 'warn.wav')]]);
  });

  it('Linux는 paplay가 없으면 aplay로 넘어가고, 둘 다 없으면 실패한다', async () => {
    const calls: string[] = [];
    const onlyAplay = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'paplay') throw new Error('ENOENT');
    };
    await new SoundAdapter(opts('linux', onlyAplay)).play('down');
    expect(calls).toEqual(['paplay', 'aplay']);
    await expect(new SoundAdapter(opts('linux', async () => { throw new Error('ENOENT'); })).play('down')).rejects.toThrow('ENOENT');
  });

  it('꺼져 있으면 재생하지 않고, 켬 여부는 알림마다 다시 확인한다', async () => {
    let enabled = false;
    const run = vi.fn(async () => {});
    const adapter = new SoundAdapter({ ...opts('darwin', run), enabled: async () => enabled });
    await adapter.send([alert()]);
    expect(run).not.toHaveBeenCalled();
    enabled = true;
    await adapter.send([alert()]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('pickSound: 첫 번째 무음이 아닌 알림의 소리를 고른다', () => {
    expect(pickSound([alert()])).toBe('up');
    expect(pickSound([alert({ sound: 'off' }), alert({ kind: 'down' })])).toBe('down');
    expect(pickSound([alert({ sound: 'warn' })])).toBe('warn');
    expect(pickSound([alert({ sound: 'off' })])).toBeUndefined();
    expect(pickSound([])).toBeUndefined();
  });
});

describe('번들 음원 (D-11, D-29, NFR-LEGAL-02)', () => {
  const kinds = ['up', 'down', 'account', 'warn'] as const;

  it('4종 WAV가 있고 PCM 형식·1.5초 이하·100KB 이하다', () => {
    for (const k of kinds) {
      const file = join(DEFAULT_SOUND_DIR, `${k}.wav`);
      expect(existsSync(file), k).toBe(true);
      expect(statSync(file).size, k).toBeLessThanOrEqual(100 * 1024);
      const b = readFileSync(file);
      expect(b.toString('ascii', 0, 4)).toBe('RIFF');
      expect(b.toString('ascii', 8, 12)).toBe('WAVE');
      const format = b.readUInt16LE(20);
      const channels = b.readUInt16LE(22);
      const rate = b.readUInt32LE(24);
      const bits = b.readUInt16LE(34);
      expect([format, bits], k).toEqual([1, 16]); // PCM 16비트: 기본 재생 도구가 모두 지원
      const dataStart = b.indexOf('data') + 8;
      const seconds = (b.length - dataStart) / (rate * channels * (bits / 8));
      expect(seconds, k).toBeGreaterThan(0.05);
      expect(seconds, k).toBeLessThanOrEqual(1.5);
    }
  });

  it('NFR-LEGAL-02 LICENSES.md에 음원마다 출처 행이 있고 해시가 실제 파일과 같으며 CC0로 기록되어 있다', () => {
    const md = readFileSync(join(DEFAULT_SOUND_DIR, 'LICENSES.md'), 'utf8');
    expect(md).toContain('CC0');
    expect(md).toContain('https://kenney.nl/assets/interface-sounds');
    for (const k of kinds) {
      const row = md.split('\n').find((l) => l.startsWith(`| \`${k}.wav\``));
      expect(row, k).toBeDefined();
      const sha = createHash('sha256').update(readFileSync(join(DEFAULT_SOUND_DIR, `${k}.wav`))).digest('hex');
      expect(row, k).toContain(sha);
      expect(row, k).toMatch(/\.ogg/);
    }
  });
});
