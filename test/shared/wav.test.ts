import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectWav, sha256Hex } from '../../src/shared/wav.js';

/** 시험용 WAV를 만든다 */
export function makeWav(o: { tag?: number; channels?: number; rate?: number; bits?: number; ms?: number; dataBytes?: number } = {}): Uint8Array {
  const channels = o.channels ?? 1;
  const rate = o.rate ?? 22050;
  const bits = o.bits ?? 16;
  const align = channels * (bits / 8);
  const frames = Math.round(((o.ms ?? 200) / 1000) * rate);
  const dataSize = o.dataBytes ?? frames * align;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(o.tag ?? 1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * align, 28);
  buf.writeUInt16LE(align, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return new Uint8Array(buf);
}

describe('wav 검사', () => {
  it('AC-75 번들 소리 4개는 모두 검사를 통과한다', () => {
    const dir = new URL('../../assets/sounds/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.wav'));
    expect(files.length).toBe(4);
    for (const f of files) expect(inspectWav(readFileSync(new URL(f, dir))).ok, f).toBe(true);
  });

  it('AC-75 정상 파일은 길이·채널·샘플레이트를 돌려준다', () => {
    const r = inspectWav(makeWav({ channels: 2, rate: 44100, ms: 500 }));
    expect(r).toMatchObject({ ok: true, info: { channels: 2, sampleRate: 44100, durationMs: 500 } });
  });

  it.each([
    ['wav가 아님', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), 'not-wav'],
    ['빈 파일', new Uint8Array(0), 'not-wav'],
    ['압축 형식', makeWav({ tag: 3 }), 'not-pcm'],
    ['8비트', makeWav({ bits: 8 }), 'bad-format'],
    ['3채널', makeWav({ channels: 3 }), 'bad-format'],
    ['샘플레이트 낮음', makeWav({ rate: 4000 }), 'bad-format'],
    ['샘플레이트 높음', makeWav({ rate: 96000 }), 'bad-format'],
    ['3초 초과', makeWav({ ms: 3500 }), 'too-long'],
    ['데이터 없음', makeWav({ dataBytes: 0 }), 'corrupt'],
  ] as const)('AC-75 %s → 거부', (_n, bytes, reason) => {
    const r = inspectWav(bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });

  it('AC-75 512KB 초과는 거부', () => {
    const r = inspectWav(new Uint8Array(512 * 1024 + 1));
    expect(r).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('AC-75 헤더가 선언한 크기보다 파일이 짧으면 거부', () => {
    const w = makeWav({ ms: 200 });
    const r = inspectWav(w.slice(0, w.length - 100));
    expect(r).toMatchObject({ ok: false, reason: 'corrupt' });
  });

  it('AC-76 sha256Hex는 알려진 값과 같다', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
