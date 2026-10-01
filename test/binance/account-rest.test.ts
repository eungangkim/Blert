import { describe, expect, it, vi } from 'vitest';
import { fetchBalances, fetchTrades } from '../../src/binance/account-rest.js';
import { credentialsFrom } from '../../src/security/index.js';
import { MAINNET_HOSTS } from '../../src/shared/network.js';
import { Logger } from '../../src/shared/logger.js';
import { FAKE_API_KEY, makeEd25519 } from '../security/helpers.js';
import { FakeAccountRest } from './fakeApi.js';

const NOW = Date.UTC(2026, 9, 5, 12);

function setup() {
  const key = makeEd25519();
  const rest = new FakeAccountRest(key.publicKey, FAKE_API_KEY);
  const logs: string[] = [];
  const sleep = vi.fn(async (_ms: number) => {});
  const creds = credentialsFrom({ apiKey: FAKE_API_KEY, privateKeyPem: key.pem });
  const opts = { base: 'https://api.binance.com', allowedHosts: MAINNET_HOSTS, fetchFn: rest.fetchFn, sleep, now: () => NOW, logger: new Logger({ write: (l) => logs.push(l) }, 'debug') };
  return { key, rest, logs, sleep, creds, opts };
}

describe('account REST 조회 (GET /api/v3/account, /api/v3/myTrades)', () => {
  it('쿼리를 서명해 signature를 마지막에 붙이고 X-MBX-APIKEY 헤더를 보낸다 (공개키로 검증)', async () => {
    const { rest, creds, opts } = setup();
    rest.balances = [{ asset: 'USDT', free: 12.5, locked: 1 }];
    const r = await fetchBalances(creds, opts);
    expect(r).toEqual({ ok: true, balances: [{ asset: 'USDT', free: 12.5, locked: 1 }] });
    expect(rest.invalidSignatures).toBe(0);
    expect(rest.calls[0]).toMatchObject({ path: '/api/v3/account', params: { recvWindow: '5000', timestamp: String(NOW) }, headers: { 'X-MBX-APIKEY': FAKE_API_KEY } });
  });

  it('체결을 시각순으로 변환하고, 1000건이 꽉 찬 쪽이 오면 마지막 체결 시각 다음부터 이어서 받는다', async () => {
    const { rest, creds, opts } = setup();
    rest.trades = Array.from({ length: 1002 }, (_, i) => ({ symbol: 'BTCUSDT', id: i + 1, orderId: 1, price: 100, qty: 1, time: NOW + i * 10, isBuyer: i % 2 === 0 }));
    const r = await fetchTrades('BTCUSDT', NOW, creds, opts);
    expect(r.ok && r.trades).toHaveLength(1002);
    expect(r.ok && r.trades[0]).toMatchObject({ symbol: 'BTCUSDT', tradeId: 1, side: 'BUY', qty: 1, price: 100 });
    expect(r.ok && r.trades[1]!.side).toBe('SELL');
    expect(rest.tradeCalls().map((c) => c.startTime)).toEqual([NOW, NOW + 999 * 10 + 1]); // 두 번째 쪽은 첫 쪽의 마지막 시각 다음
  });

  it('없는 심볼(-1121)은 invalid-symbol, 키 거부는 rejected로 구분한다', async () => {
    const { rest, creds, opts } = setup();
    rest.invalidSymbols.add('ZZZUSDT');
    expect(await fetchTrades('ZZZUSDT', NOW, creds, opts)).toEqual({ ok: false, reason: 'invalid-symbol' });
    const rejected = await fetchBalances(creds, { ...opts, fetchFn: vi.fn(async () => new Response(JSON.stringify({ code: -2015, msg: 'x' }), { status: 401 })) as unknown as typeof fetch });
    expect(rejected).toEqual({ ok: false, reason: 'rejected' });
  });

  it('429/418이 반복되면 Retry-After만큼 3번 쉬고 포기한다 (기본 60초, 최대 5분)', async () => {
    const { creds, opts, sleep } = setup();
    const always = vi.fn(async () => new Response('{}', { status: 418 }));
    expect(await fetchBalances(creds, { ...opts, fetchFn: always as unknown as typeof fetch })).toEqual({ ok: false, reason: 'rate-limited' });
    expect(always).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([60_000, 60_000, 60_000]);

    const long = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '99999' } })).mockResolvedValue(new Response(JSON.stringify({ balances: [] }), { status: 200 }));
    sleep.mockClear();
    expect(await fetchBalances(creds, { ...opts, fetchFn: long as unknown as typeof fetch })).toEqual({ ok: true, balances: [] });
    expect(sleep).toHaveBeenCalledWith(300_000);
  });

  it('여러 쪽 중 뒤쪽이 실패해도 앞에서 받은 체결은 돌려준다', async () => {
    const { rest, creds, opts } = setup();
    rest.trades = Array.from({ length: 1000 }, (_, i) => ({ symbol: 'BTCUSDT', id: i + 1, orderId: 1, price: 1, qty: 1, time: NOW + i, isBuyer: true }));
    let n = 0;
    const flaky = vi.fn(async (input: string | URL | Request, init?: RequestInit) => (++n === 2 ? new Response('{}', { status: 500 }) : rest.fetch(input, init)));
    const r = await fetchTrades('BTCUSDT', NOW, creds, { ...opts, fetchFn: flaky as unknown as typeof fetch });
    expect(r.ok && r.trades).toHaveLength(1000);
  });

  it('바이낸스 도메인이 아니면 요청하지 않고, 네트워크 오류는 던지지 않는다 (NFR-SEC-02)', async () => {
    const { rest, creds, opts, logs } = setup();
    expect(await fetchBalances(creds, { ...opts, base: 'https://evil.example.com' })).toEqual({ ok: false, reason: 'blocked' });
    expect(rest.fetch).not.toHaveBeenCalled();
    expect(await fetchBalances(creds, { ...opts, fetchFn: vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch })).toEqual({ ok: false, reason: 'network' });
    expect(logs.join('\n')).not.toContain(FAKE_API_KEY);
  });

  it('응답 형식이 이상하면 실패로 돌려주고, 형식이 깨진 행은 건너뛴다', async () => {
    const { creds, opts } = setup();
    const weird = vi.fn(async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 }));
    expect(await fetchBalances(creds, { ...opts, fetchFn: weird as unknown as typeof fetch })).toEqual({ ok: false, reason: 'http' });
    const partial = vi.fn(async () => new Response(JSON.stringify({ balances: [{ asset: 'BTC', free: '1', locked: '0' }, { asset: 'X', free: 'abc', locked: '0' }, { free: '1' }] }), { status: 200 }));
    expect(await fetchBalances(creds, { ...opts, fetchFn: partial as unknown as typeof fetch })).toEqual({ ok: true, balances: [{ asset: 'BTC', free: 1, locked: 0 }] });
  });
});
