import { createHash } from 'node:crypto';

/** 사용자 소리 검사 기준 (D-92). 번들 소리 4개도 이 기준을 통과한다. */
export const WAV_LIMITS = { maxBytes: 512 * 1024, maxMs: 3000, minRate: 8000, maxRate: 48000 } as const;
/** 헤더를 훑을 때 읽는 청크 수 상한 (이상한 파일이 오래 붙잡지 못하게) */
const MAX_CHUNKS = 32;

export interface WavInfo {
  channels: 1 | 2;
  sampleRate: number;
  durationMs: number;
  bytes: number;
}

export type WavProblem =
  /** 파일이 너무 크다 */
  | 'too-large'
  /** WAV(RIFF/WAVE)가 아니다 */
  | 'not-wav'
  /** PCM이 아니다 (압축·확장 형식). Windows 재생기가 PCM만 재생한다 */
  | 'not-pcm'
  /** 16비트가 아니거나 채널 수·샘플레이트가 기준 밖이다 */
  | 'bad-format'
  | 'too-long'
  /** 헤더와 데이터가 맞지 않는다 */
  | 'corrupt';

export type WavResult = { ok: true; info: WavInfo } | { ok: false; reason: WavProblem; detail?: string };

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const tag = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

/**
 * 소리 파일을 저장하기 전에 직접 검사한다 (D-92). OS 재생기가 잘못 만든 파일을 열지 않게 하는 마지막 방어선이라
 * 모르는 형식은 모두 거부한다: PCM 16비트, 모노·스테레오, 8,000~48,000Hz, 3초 이하, 512KB 이하.
 */
export function inspectWav(bytes: Uint8Array): WavResult {
  if (bytes.length > WAV_LIMITS.maxBytes) return { ok: false, reason: 'too-large' };
  if (bytes.length < 12 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') return { ok: false, reason: 'not-wav' };
  const end = u32(bytes, 4) + 8;
  if (end > bytes.length || end < 12) return { ok: false, reason: 'corrupt', detail: 'riff size' };

  let pos = 12;
  let fmt: { tag: number; channels: number; rate: number; byteRate: number; align: number; bits: number } | undefined;
  let dataSize: number | undefined;
  for (let n = 0; pos + 8 <= end && n < MAX_CHUNKS; n++) {
    const id = tag(bytes, pos);
    const size = u32(bytes, pos + 4);
    const body = pos + 8;
    if (body + size > end) return { ok: false, reason: 'corrupt', detail: `chunk ${id}` };
    if (id === 'fmt ' && fmt === undefined) {
      if (size < 16) return { ok: false, reason: 'corrupt', detail: 'fmt size' };
      fmt = { tag: u16(bytes, body), channels: u16(bytes, body + 2), rate: u32(bytes, body + 4), byteRate: u32(bytes, body + 8), align: u16(bytes, body + 12), bits: u16(bytes, body + 14) };
    } else if (id === 'data' && dataSize === undefined) {
      if (fmt === undefined) return { ok: false, reason: 'corrupt', detail: 'data before fmt' };
      dataSize = size;
      break;
    }
    pos = body + size + (size & 1);
  }
  if (fmt === undefined || dataSize === undefined) return { ok: false, reason: 'corrupt', detail: 'missing chunk' };

  if (fmt.tag !== 1) return { ok: false, reason: 'not-pcm', detail: `format ${fmt.tag}` };
  if (fmt.bits !== 16) return { ok: false, reason: 'bad-format', detail: `${fmt.bits}-bit` };
  if (fmt.channels !== 1 && fmt.channels !== 2) return { ok: false, reason: 'bad-format', detail: `${fmt.channels} channels` };
  if (fmt.rate < WAV_LIMITS.minRate || fmt.rate > WAV_LIMITS.maxRate) return { ok: false, reason: 'bad-format', detail: `${fmt.rate} Hz` };
  if (fmt.align !== fmt.channels * 2 || fmt.byteRate !== fmt.rate * fmt.align) return { ok: false, reason: 'corrupt', detail: 'fmt fields' };
  if (dataSize === 0 || dataSize % fmt.align !== 0) return { ok: false, reason: 'corrupt', detail: 'data size' };

  const durationMs = Math.round((dataSize / fmt.byteRate) * 1000);
  if (durationMs > WAV_LIMITS.maxMs) return { ok: false, reason: 'too-long', detail: `${durationMs} ms` };
  return { ok: true, info: { channels: fmt.channels as 1 | 2, sampleRate: fmt.rate, durationMs, bytes: bytes.length } };
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
