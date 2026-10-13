import { describe, expect, it } from 'vitest';
import { download, safeOrigin } from '../../src/shared/download.js';
import { sha256Hex } from '../../src/shared/wav.js';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const fakeFetch = (h: Handler, log: { url: string; init: RequestInit }[] = []): typeof fetch =>
  (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    log.push({ url, init });
    return h(url, init);
  }) as typeof fetch;

const body = new Uint8Array([1, 2, 3, 4, 5]);

describe('내려받기', () => {
  it('AC-74 https 주소에서 받고 sha256을 계산한다 (GET, 쿠키·인증 없음)', async () => {
    const log: { url: string; init: RequestInit }[] = [];
    const r = await download('https://example.com/a.wav', { maxBytes: 100, fetchFn: fakeFetch(() => new Response(body), log) });
    expect(r).toMatchObject({ ok: true, sha256: sha256Hex(body), finalUrl: 'https://example.com/a.wav' });
    expect(log).toHaveLength(1);
    expect(log[0]!.init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'manual' });
    expect(JSON.stringify(log[0]!.init.headers ?? {})).not.toMatch(/cookie|authorization/i);
  });

  it('AC-77 http 주소는 요청 없이 거부', async () => {
    const log: { url: string; init: RequestInit }[] = [];
    const r = await download('http://example.com/a.wav', { maxBytes: 100, fetchFn: fakeFetch(() => new Response(body), log) });
    expect(r).toMatchObject({ ok: false, reason: 'insecure' });
    expect(log).toHaveLength(0);
  });

  it.each(['not a url', 'ftp://example.com/a.wav', 'https://user:pw@example.com/a.wav'])('AC-77 잘못된 주소 %s는 요청 없이 거부', async (u) => {
    const log: { url: string; init: RequestInit }[] = [];
    const r = await download(u, { maxBytes: 100, fetchFn: fakeFetch(() => new Response(body), log) });
    expect(r.ok).toBe(false);
    expect(log).toHaveLength(0);
  });

  it('AC-77 같은 호스트 https 리다이렉트는 따라간다', async () => {
    const f = fakeFetch((u) => (u.endsWith('/a') ? new Response(null, { status: 302, headers: { location: '/b' } }) : new Response(body)));
    const r = await download('https://example.com/a', { maxBytes: 100, fetchFn: f });
    expect(r).toMatchObject({ ok: true, finalUrl: 'https://example.com/b' });
  });

  it.each([
    ['다른 호스트', 'https://evil.example.org/x'],
    ['http로 하향', 'http://example.com/x'],
  ])('AC-77 리다이렉트 %s는 거부', async (_n, loc) => {
    const r = await download('https://example.com/a', {
      maxBytes: 100,
      fetchFn: fakeFetch(() => new Response(null, { status: 301, headers: { location: loc } })),
    });
    expect(r).toMatchObject({ ok: false, reason: 'redirect' });
  });

  it('AC-77 리다이렉트가 4번을 넘으면 거부', async () => {
    const r = await download('https://example.com/a', {
      maxBytes: 100,
      fetchFn: fakeFetch(() => new Response(null, { status: 302, headers: { location: '/a' } })),
    });
    expect(r).toMatchObject({ ok: false, reason: 'redirect' });
  });

  it('AC-77 Content-Length가 상한을 넘으면 거부', async () => {
    const r = await download('https://example.com/a', {
      maxBytes: 4,
      fetchFn: fakeFetch(() => new Response(body, { headers: { 'content-length': '500' } })),
    });
    expect(r).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('AC-77 Content-Length를 속여도 읽다가 상한에서 멈춘다', async () => {
    const r = await download('https://example.com/a', { maxBytes: 4, fetchFn: fakeFetch(() => new Response(body)) });
    expect(r).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('AC-77 응답이 없으면 시간 제한에서 중단', async () => {
    const f = fakeFetch((_u, init) => new Promise<Response>((_res, rej) => init.signal?.addEventListener('abort', () => rej(init.signal!.reason))));
    const r = await download('https://example.com/a', { maxBytes: 100, timeoutMs: 30, fetchFn: f });
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('AC-77 404는 http 실패로 보고', async () => {
    const r = await download('https://example.com/a', { maxBytes: 100, fetchFn: fakeFetch(() => new Response('no', { status: 404 })) });
    expect(r).toMatchObject({ ok: false, reason: 'http', status: 404 });
  });

  it('AC-77 연결 오류는 network 실패', async () => {
    const r = await download('https://example.com/a', {
      maxBytes: 100,
      fetchFn: fakeFetch(() => {
        throw new TypeError('fetch failed');
      }),
    });
    expect(r).toMatchObject({ ok: false, reason: 'network' });
  });

  it('AC-80 출처 표기에는 쿼리·프래그먼트·사용자 정보가 빠진다', () => {
    expect(safeOrigin('https://user:pw@cdn.example.com/s/up.wav?token=abc#frag')).toBe('cdn.example.com/s/up.wav');
    expect(safeOrigin('nope')).toBeUndefined();
  });
});
