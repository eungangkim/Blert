import { readFile, stat } from 'node:fs/promises';
import { BlertError, ExitCode } from '../shared/errors.js';
import { safeOrigin, type DownloadFailure } from '../shared/download.js';
import type { Deps } from './types.js';

/** 파일·주소 방식 설치(소리, 프리셋)가 함께 쓰는 입력 도우미 (D-93) */

export const SHA256 = /^[0-9a-f]{64}$/i;
/** `scheme://`로 시작하면 주소로 본다 (http 등 https가 아닌 것은 내려받기 단계에서 거부한다) */
export const isUrl = (s: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

const NETWORK_FAILURES: readonly DownloadFailure[] = ['timeout', 'network', 'http'];

/** 주소에서 받는다. 실패 이유를 오류 문구로 바꾼다 (D-78) */
export async function fetchBytes(deps: Deps, url: string, maxBytes: number): Promise<{ bytes: Uint8Array; sha256: string }> {
  const r = await deps.downloader.download(url, { maxBytes });
  if (r.ok) return r;
  throw new BlertError(`err.download.${r.reason}`, { url: safeOrigin(url) ?? '', status: r.status ?? 0, limit: Math.round(maxBytes / 1024) }, NETWORK_FAILURES.includes(r.reason) ? ExitCode.connection : ExitCode.input);
}

/** 로컬 파일을 읽는다. 크기 상한을 넘으면 읽기 전에 거부한다. readErrorKey는 읽기 실패 문구 키 */
export async function readLocal(path: string, maxBytes: number, readErrorKey = 'err.soundFileRead'): Promise<Uint8Array> {
  try {
    if ((await stat(path)).size > maxBytes) throw new BlertError('err.download.too-large', { url: '', status: 0, limit: Math.round(maxBytes / 1024) });
    return new Uint8Array(await readFile(path));
  } catch (e) {
    if (e instanceof BlertError) throw e;
    throw new BlertError(readErrorKey, { path });
  }
}

/** `--sha256` 값과 받은 파일의 해시를 비교한다. 다르면 설치하지 않는다 (D-76·D-79) */
export function checkHash(actual: string, expected: string | undefined, key = 'err.soundHash'): void {
  if (expected !== undefined && expected.toLowerCase() !== actual) throw new BlertError(key, { expected: expected.toLowerCase(), actual });
}
