import { describe, expect, it, vi } from 'vitest';
import { fetchKlineEvents } from '../../src/binance/rest.js';
import { Logger } from '../../src/shared/logger.js';
import { klineRows } from './fakeNetwork.js';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 3, 0, 0, 30);
const NOW_MIN = Math.floor(NOW / MIN) * MIN;

const ok = (rows: unknown[][]) => new Response(JSON.stringify(rows), { status: 200 });
const opts = (fetchFn: unknown, sleep = vi.fn(async (_ms: number) => {})) => {
  const logs: string[] = [];
  return { fetchFn: fetchFn as typeof fetch, sleep, now: () => NOW, logger: new Logger({ write: (l) => logs.push(l) }, 'debug'), logs };
};

describe('binance REST 백필 오류 처리 (B5 레이트 리밋)', () => {
  it('429는 Retry-After만큼 쉬고 다시 시도해 성공하면 데이터를 돌려준다', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(ok(klineRows(NOW_MIN - 2 * MIN, 3)));
    const o = opts(fetchFn);
    const res = await fetchKlineEvents('spot', 'BTCUSDT', NOW_MIN - 2 * MIN, o);
    expect(o.sleep).toHaveBeenCalledWith(2000);
    expect(res.ok).toBe(true);
    expect(res.events).toHaveLength(3);
    expect(o.logs.join('\n')).toContain('rate limited (429)');
  });

  it('418/429가 반복되면 3번 쉰 뒤 예외 없이 포기하고 경고를 남긴다 (Retry-After 기본 60초)', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 418 }));
    const o = opts(fetchFn);
    const res = await fetchKlineEvents('futures', 'BTCUSDT', NOW_MIN, o);
    expect(res).toEqual({ ok: false, reason: 'rate-limited', events: [] });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(o.sleep.mock.calls.map((c) => c[0])).toEqual([60_000, 60_000, 60_000]);
  });

  it('Retry-After가 지나치게 길어도 5분까지만 기다린다', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '99999' } }))
      .mockResolvedValueOnce(ok([]));
    const o = opts(fetchFn);
    await fetchKlineEvents('spot', 'BTCUSDT', NOW_MIN, o);
    expect(o.sleep).toHaveBeenCalledWith(300_000);
  });

  it('네트워크 오류·서버 오류는 실패로 돌려주고 던지지 않는다', async () => {
    const boom = opts(vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    expect(await fetchKlineEvents('spot', 'BTCUSDT', NOW_MIN, boom)).toMatchObject({ ok: false, reason: 'failed' });
    const err500 = opts(vi.fn(async () => new Response('', { status: 500 })));
    expect(await fetchKlineEvents('spot', 'BTCUSDT', NOW_MIN, err500)).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('여러 쪽 중 뒤쪽이 실패해도 앞에서 받은 데이터는 돌려준다', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(ok(klineRows(NOW_MIN - 1500 * MIN, 1000)))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    const res = await fetchKlineEvents('spot', 'BTCUSDT', NOW_MIN - 1500 * MIN, opts(fetchFn));
    expect(res.ok).toBe(false);
    expect(res.events).toHaveLength(1000);
  });

  it('형식이 깨진 행은 건너뛴다', async () => {
    const rows = klineRows(NOW_MIN - MIN, 2);
    rows[0]![7] = 'NaN?';
    const res = await fetchKlineEvents('spot', 'BTCUSDT', NOW_MIN - MIN, opts(vi.fn(async () => ok(rows))));
    expect(res.events).toHaveLength(1);
  });
});
