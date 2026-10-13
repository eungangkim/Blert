import { sha256Hex } from './wav.js';

/** 주소 방식 내려받기의 안전장치 (D-78, D-82). 사용자가 명령에 직접 입력한 주소에서만 쓴다. */
export const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export type DownloadFailure =
  /** 주소 형식이 틀렸거나 사용자 정보(user:pass@)가 들어 있다 */
  | 'invalid-url'
  /** https가 아니다 */
  | 'insecure'
  /** 다른 호스트나 http로 이동하려 했거나 이동이 너무 많다 */
  | 'redirect'
  | 'too-large'
  | 'timeout'
  | 'network'
  | 'http';

export type DownloadResult =
  | { ok: true; bytes: Uint8Array; sha256: string; finalUrl: string }
  | { ok: false; reason: DownloadFailure; status?: number };

export interface DownloadOptions {
  maxBytes: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/** https 주소만 받는다. 사용자 정보가 든 주소는 거부한다. */
function parseHttps(raw: string): URL | DownloadFailure {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'invalid-url';
  }
  if (u.protocol !== 'https:') return u.protocol === 'http:' ? 'insecure' : 'invalid-url';
  if (u.username || u.password) return 'invalid-url';
  return u;
}

/**
 * 파일 하나를 내려받는다. GET만 하고, 쿠키·인증 정보·사용자 정보를 보내지 않는다.
 * https만, 크기·시간 제한, 같은 호스트의 https로 가는 리다이렉트만 최대 3번 따라간다.
 */
export async function download(url: string, o: DownloadOptions): Promise<DownloadResult> {
  const fetchFn = o.fetchFn ?? fetch;
  const signal = AbortSignal.timeout(o.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  let current = parseHttps(url);
  if (typeof current === 'string') return { ok: false, reason: current };
  const host = current.hostname.toLowerCase();

  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetchFn(current.href, { method: 'GET', redirect: 'manual', credentials: 'omit', signal });
    } catch (e) {
      return { ok: false, reason: signal.aborted || (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? 'timeout' : 'network' };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      void res.body?.cancel().catch(() => {});
      if (!location || hop >= MAX_REDIRECTS) return { ok: false, reason: 'redirect' };
      const next = parseHttps(new URL(location, current).href);
      if (typeof next === 'string' || next.hostname.toLowerCase() !== host) return { ok: false, reason: 'redirect' };
      current = next;
      continue;
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return { ok: false, reason: 'http', status: res.status };
    }

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > o.maxBytes) {
      void res.body?.cancel().catch(() => {});
      return { ok: false, reason: 'too-large' };
    }
    try {
      const bytes = await readLimited(res, o.maxBytes);
      if (bytes === undefined) return { ok: false, reason: 'too-large' };
      return { ok: true, bytes, sha256: sha256Hex(bytes), finalUrl: current.href };
    } catch (e) {
      return { ok: false, reason: signal.aborted || (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? 'timeout' : 'network' };
    }
  }
}

/** 크기 상한을 넘으면 읽기를 멈추고 undefined를 돌려준다 (Content-Length를 속여도 막힌다) */
async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    return all.byteLength > maxBytes ? undefined : all;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * 설정과 로그에 남기는 출처 표기 (D-97). 쿼리·프래그먼트·사용자 정보를 빼고 호스트와 경로만 남긴다.
 * 주소가 아니면 undefined.
 */
export function safeOrigin(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return undefined;
  }
}
