import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FuturesAccountFeed, type AuthorizeResult, type FuturesWants } from '../../src/binance/index.js';
import { ROTATE_AFTER_MS } from '../../src/binance/connection.js';
import { FUTURES_ACCOUNT_ENDPOINTS } from '../../src/binance/endpoints.js';
import { EventBus } from '../../src/shared/bus.js';
import { Logger } from '../../src/shared/logger.js';
import type { BlertEvent } from '../../src/shared/events.js';
import { credentialsFrom } from '../../src/security/index.js';
import { FAKE_API_KEY, makeEd25519 } from '../security/helpers.js';
import { FakeFuturesApi, accountUpdate, listenKeyExpired, orderTradeUpdate } from './fakeFutures.js';

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const WS = 'wss://fstream.binance.com/private/ws';

function setup(extra: Partial<ConstructorParameters<typeof FuturesAccountFeed>[0]> = {}, wantsInit: Partial<FuturesWants> = {}) {
  const bus = new EventBus();
  const events: BlertEvent[] = [];
  for (const t of ['account.fill', 'account.position', 'conn.status', 'conn.gap'] as const) bus.on(t, (e) => events.push(e));
  const key = makeEd25519();
  const api = new FakeFuturesApi(key.publicKey, FAKE_API_KEY);
  const creds = credentialsFrom({ apiKey: FAKE_API_KEY, privateKeyPem: key.pem });
  const state = {
    authorize: (async (): Promise<AuthorizeResult> => ({ ok: true, credentials: creds })) as () => Promise<AuthorizeResult>,
    wants: { fillSymbols: ['BTCUSDT'], liqSymbols: ['BTCUSDT'], ...wantsInit } as FuturesWants,
  };
  const authorizeSpy = vi.fn(() => state.authorize());
  const logs: string[] = [];
  const onFatal = vi.fn();
  const feed = new FuturesAccountFeed({
    bus, authorize: authorizeSpy, wants: () => state.wants, onFatal,
    clock: { now: () => Date.now() }, logger: new Logger({ write: (l) => logs.push(l) }, 'debug'),
    wsFactory: api.factory, fetchFn: api.fetchFn, sleep: async () => {}, ...extra,
  });
  const of = <T extends BlertEvent['type']>(type: T) => events.filter((e) => e.type === type) as Extract<BlertEvent, { type: T }>[];
  return { feed, bus, events, of, key, api, state, authorizeSpy, logs, onFatal };
}

let feeds: FuturesAccountFeed[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  for (const f of feeds) f.stop();
  feeds = [];
  vi.useRealTimers();
});
const make = (...args: Parameters<typeof setup>) => {
  const h = setup(...args);
  feeds.push(h.feed);
  return h;
};
const start = async (h: ReturnType<typeof make>) => {
  h.feed.start();
  await tick(0);
};
const long = (symbol = 'BTCUSDT', amt = '0.5', mark = '90000', liq = '80000') => ({ symbol, positionAmt: amt, markPrice: mark, liquidationPrice: liq });

describe('선물 계정 연결: listenKey 방식 (D-45, FR-ACC-03)', () => {
  it('AC-39 서명 없이 API 키 헤더만으로 listenKey를 받아 private 스트림에 연결하고, 포지션을 읽는다', async () => {
    const h = make();
    h.api.positions = [long()];
    await start(h);
    const [post] = h.api.callsTo('/fapi/v1/listenKey', 'POST');
    expect(post).toMatchObject({ origin: 'https://fapi.binance.com', headers: { 'X-MBX-APIKEY': FAKE_API_KEY }, hasSignature: false });
    expect(h.api.sockets[0]!.url).toBe(`${WS}?listenKey=LK-1&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE`);
    expect(h.feed.status).toEqual({ stream: 'futures-account', state: 'open', attempt: 0 });
    const positions = h.of('account.position');
    expect(positions.map((p) => [p.symbol, p.side, p.size, p.liqPrice, p.markPrice])).toEqual([
      ['BTCUSDT', 'LONG', 0.5, 80_000, 90_000],
      ['BTCUSDT', 'SHORT', 0, 0, 90_000], // 없는 방향은 크기 0으로 내보내 이전 값을 지운다
    ]);
    expect(h.api.invalidSignatures).toBe(0);
    expect(h.api.callsTo('/fapi/v3/positionRisk')[0]!.hasSignature).toBe(true); // 포지션 조회는 서명한다
  });

  it('단방향 포지션은 수량의 부호로, 양방향(헤지)은 positionSide로 방향을 정한다', async () => {
    const h = make();
    h.api.positions = [
      { symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '1', markPrice: '100', liquidationPrice: '90' },
      { symbol: 'BTCUSDT', positionSide: 'SHORT', positionAmt: '-2', markPrice: '100', liquidationPrice: '110' },
      { symbol: 'ETHUSDT', positionAmt: '-3', markPrice: '10', liquidationPrice: '12' }, // 감시하지 않는 심볼
    ];
    await start(h);
    expect(h.of('account.position').map((p) => [p.side, p.size, p.liqPrice])).toEqual([['LONG', 1, 90], ['SHORT', 2, 110]]);
    const one = make({}, { liqSymbols: ['ETHUSDT'] });
    one.api.positions = [{ symbol: 'ETHUSDT', positionAmt: '-3', markPrice: '10', liquidationPrice: '12' }];
    await start(one);
    expect(one.of('account.position').map((p) => [p.side, p.size])).toEqual([['LONG', 0], ['SHORT', 3]]);
  });

  it('AC-39 ORDER_TRADE_UPDATE는 x가 TRADE일 때만 선물 체결로 바꾸고, 같은 체결 ID는 한 번만 알린다', async () => {
    const h = make();
    await start(h);
    h.api.event(orderTradeUpdate({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.01, price: 83_000, orderId: 5, tradeId: 77, type: 'NEW' }));
    h.api.event(orderTradeUpdate({ symbol: 'BTCUSDT', side: 'SELL', qty: '0.01', price: '83000.5', orderId: 5, tradeId: 77 }));
    h.api.event(orderTradeUpdate({ symbol: 'BTCUSDT', side: 'SELL', qty: '0.01', price: '83000.5', orderId: 5, tradeId: 77 })); // 중복
    expect(h.of('account.fill')).toEqual([
      { type: 'account.fill', ts: new Date(T0).toISOString(), market: 'futures', symbol: 'BTCUSDT', side: 'SELL', qty: 0.01, price: 83_000.5, orderId: 5, tradeId: 77 },
    ]);
  });

  it('형식이 이상한 이벤트(숫자가 아님, 체결 ID 없음)와 JSON이 아닌 메시지는 무시한다', async () => {
    const h = make();
    await start(h);
    const bad = orderTradeUpdate({ symbol: 'BTCUSDT', side: 'BUY', qty: 'abc', price: 1, orderId: 1, tradeId: 1 });
    h.api.event(bad);
    h.api.live[0]!.onmessage?.({ data: 'not json' });
    h.api.live[0]!.onmessage?.({ data: '[]' });
    expect(h.of('account.fill')).toHaveLength(0);
  });

  it('AC-35 계정 갱신 이벤트가 연달아 와도 포지션 조회는 한 번이다 (청산가는 이벤트에 없다)', async () => {
    const h = make();
    h.api.positions = [long()];
    await start(h);
    const before = h.api.callsTo('/fapi/v3/positionRisk').length;
    h.api.event(accountUpdate());
    h.api.event(accountUpdate());
    h.api.event(orderTradeUpdate({ symbol: 'BTCUSDT', side: 'BUY', qty: 1, price: 1, orderId: 1, tradeId: 1 }));
    await tick(600);
    expect(h.api.callsTo('/fapi/v3/positionRisk')).toHaveLength(before + 1);
  });

  it('AC-35 15초마다 포지션을 다시 읽어 청산가를 갱신한다 (D-50)', async () => {
    const h = make();
    h.api.positions = [long('BTCUSDT', '0.5', '90000', '80000')];
    await start(h);
    h.api.positions = [long('BTCUSDT', '0.5', '88000', '84000')]; // 증거금이 줄어 청산가가 올랐다
    await tick(15_000);
    expect(h.of('account.position').filter((p) => p.side === 'LONG').map((p) => p.liqPrice)).toEqual([80_000, 84_000]);
    await tick(15_000);
    expect(h.api.callsTo('/fapi/v3/positionRisk')).toHaveLength(3);
  });

  it('청산가 규칙이 없으면(체결만 감시) 포지션을 조회하지 않는다', async () => {
    const h = make({}, { liqSymbols: [] });
    await start(h);
    await tick(60_000);
    expect(h.api.callsTo('/fapi/v3/positionRisk')).toHaveLength(0);
    expect(h.feed.status.state).toBe('open');
  });

  it('refreshNow는 규칙이 바뀌어 감시 심볼이 늘었을 때 바로 다시 읽게 한다', async () => {
    const h = make();
    h.api.positions = [long('BTCUSDT'), long('ETHUSDT', '2', '3000', '2500')];
    await start(h);
    h.state.wants = { fillSymbols: [], liqSymbols: ['BTCUSDT', 'ETHUSDT'] };
    h.feed.refreshNow();
    await tick(0);
    expect(h.of('account.position').filter((p) => p.symbol === 'ETHUSDT' && p.side === 'LONG')[0]).toMatchObject({ size: 2, liqPrice: 2500 });
  });
});

describe('선물 계정 연결: 유지·재연결 (AC-40, FR-KEY-04)', () => {
  it('AC-40 listenKey를 5분마다 유지(PUT)한다 (반쯤 끊긴 연결을 최대 5분 안에 알아채기 위함)', async () => {
    const h = make();
    await start(h);
    await tick(5 * 60_000);
    expect(h.api.callsTo('/fapi/v1/listenKey', 'PUT')).toHaveLength(1);
    expect(h.api.callsTo('/fapi/v1/listenKey', 'PUT')[0]).toMatchObject({ headers: { 'X-MBX-APIKEY': FAKE_API_KEY }, hasSignature: false });
    await tick(5 * 60_000);
    expect(h.api.callsTo('/fapi/v1/listenKey', 'PUT')).toHaveLength(2);
    expect(h.api.sockets).toHaveLength(1); // 연결은 그대로
  });

  it('AC-40 유지에 실패하면(listenKey 만료) 키를 새로 발급받아 다시 연결하고 포지션을 다시 읽고 중단 구간을 알린다', async () => {
    const h = make();
    h.api.positions = [long()];
    await start(h);
    h.api.expireNextKeepalive = true;
    await tick(5 * 60_000);
    expect(h.feed.status.state).toBe('retrying');
    const longsBefore = h.of('account.position').filter((p) => p.side === 'LONG').length;
    await tick(1000); // 첫 재시도 대기 (1초)
    expect(h.feed.status.state).toBe('open');
    expect(h.api.callsTo('/fapi/v1/listenKey', 'POST')).toHaveLength(2);
    expect(h.api.sockets[1]!.url).toContain('listenKey=LK-2');
    expect(h.api.sockets[0]!.closed).toBe(true);
    expect(h.of('account.position').filter((p) => p.side === 'LONG')).toHaveLength(longsBefore + 1); // 다시 연결하면서 포지션을 다시 읽었다
    expect(h.of('conn.gap')).toHaveLength(1);
    expect(h.of('conn.gap')[0]).toMatchObject({ reason: 'disconnect' });
  });

  it('AC-40 반쯤 끊긴 연결은 유지(PUT) 실패로 5분 안에 알아채고, 중단 구간은 알아챈 시각이 아니라 마지막 생존 시각부터 알린다 (NFR-REL-02)', async () => {
    const h = make({}, { liqSymbols: [] }); // 포지션 조회가 없어 마지막 생존 시각이 연결 시각(T0)에 머문다
    await start(h);
    h.api.expireNextKeepalive = true; // 소켓은 닫히지 않았지만 서버에서는 이미 죽은 연결
    await tick(5 * 60_000);
    expect(h.feed.status.state).toBe('retrying');
    await tick(1000);
    expect(h.feed.status.state).toBe('open');
    const [gap] = h.of('conn.gap');
    expect(gap).toMatchObject({ reason: 'disconnect', from: new Date(T0).toISOString() });
    expect(Date.parse(gap!.to)).toBeGreaterThanOrEqual(T0 + 5 * 60_000);
  });

  it('소켓이 닫혀서 바로 알아챈 끊김은 닫힌 시각부터 구간으로 센다 (마지막 생존 시각이 오래돼도 부풀리지 않는다)', async () => {
    const h = make({}, { liqSymbols: [] });
    await start(h);
    await tick(4 * 60_000);
    h.api.dropAll();
    await tick(1000);
    const [gap] = h.of('conn.gap');
    expect(Date.parse(gap!.from)).toBe(T0 + 4 * 60_000);
  });

  it('AC-40 연결이 끊기면 같은 백오프로 다시 연결하고, 매번 키 권한을 다시 확인한다 (FR-KEY-04)', async () => {
    const h = make();
    h.api.positions = [long()];
    await start(h);
    expect(h.authorizeSpy).toHaveBeenCalledTimes(1);
    h.api.dropAll();
    await tick(1000);
    expect(h.feed.status.state).toBe('open');
    expect(h.authorizeSpy).toHaveBeenCalledTimes(2);
    h.api.refuseSockets = true;
    h.api.dropAll();
    await tick(1000);
    await tick(2000);
    await tick(4000);
    expect(h.feed.status.state).toBe('retrying');
    expect(h.authorizeSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    h.api.refuseSockets = false;
    await tick(60_000);
    expect(h.feed.status.state).toBe('open');
  });

  it('AC-40 listenKeyExpired 이벤트를 받으면 새 listenKey로 다시 연결한다', async () => {
    const h = make();
    await start(h);
    h.api.event(listenKeyExpired());
    await tick(1000);
    expect(h.feed.status.state).toBe('open');
    expect(h.api.callsTo('/fapi/v1/listenKey', 'POST')).toHaveLength(2);
  });

  it('5분 넘게 끊긴 채로 있으면 경고(ongoing)를 한 번 내고, 복구되면 끝난 구간을 알린다', async () => {
    const h = make();
    await start(h);
    h.api.refuseSockets = true;
    h.api.dropAll();
    await tick(5 * 60_000 + 1000);
    expect(h.of('conn.gap').filter((g) => g.ongoing)).toHaveLength(1);
    h.api.refuseSockets = false;
    await tick(60_000);
    expect(h.of('conn.gap').filter((g) => !g.ongoing)).toHaveLength(1);
  });

  it('24시간 만료 10분 전에 미리 다시 연결한다 (끊김으로 세지 않는다)', async () => {
    const h = make();
    await start(h);
    await tick(ROTATE_AFTER_MS + 100);
    expect(h.api.sockets).toHaveLength(2);
    expect(h.feed.status.state).toBe('open');
    expect(h.of('conn.gap')).toHaveLength(0);
  });

  it('reconnectNow(절전 복귀)는 즉시 다시 연결하고 포지션을 다시 읽는다', async () => {
    const h = make();
    h.api.positions = [long()];
    await start(h);
    h.feed.reconnectNow();
    await tick(0);
    expect(h.api.sockets).toHaveLength(2);
    expect(h.api.callsTo('/fapi/v3/positionRisk')).toHaveLength(2);
  });
});

describe('선물 계정 연결: 끊긴 사이 체결 보충 (FR-CONN-02, D-44)', () => {
  const trade = (id: number, time: number, symbol = 'BTCUSDT') => ({ symbol, id, orderId: id, side: 'BUY' as const, price: 83_000, qty: 0.01, time });

  it('AC-40 끊긴 사이의 선물 체결이 재연결 직후 알림으로 오고, 이미 받은 체결은 다시 오지 않는다', async () => {
    const h = make();
    await start(h);
    h.api.event(orderTradeUpdate({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.01, price: 83_000, orderId: 1, tradeId: 1 }));
    expect(h.of('account.fill')).toHaveLength(1);
    await tick(10_000);
    h.api.refuseSockets = true;
    h.api.dropAll();
    await tick(20_000);
    // 끊긴 사이에 체결 2건 + 이미 실시간으로 받은 1건(경계 여유 구간)
    h.api.trades = [trade(1, T0 + 5_000), trade(2, T0 + 15_000), trade(3, T0 + 25_000)];
    h.api.refuseSockets = false;
    await tick(60_000);
    expect(h.feed.status.state).toBe('open');
    expect(h.of('account.fill').map((f) => f.tradeId)).toEqual([1, 2, 3]); // 1은 중복 제거
    const call = h.api.callsTo('/fapi/v1/userTrades')[0]!;
    expect(call).toMatchObject({ hasSignature: true, headers: { 'X-MBX-APIKEY': FAKE_API_KEY } });
    expect(call.params.symbol).toBe('BTCUSDT');
    expect(Number(call.params.startTime)).toBe(T0 + 500 - 60_000); // 마지막 생존 시각(체결 직후 포지션 갱신) − 60초
    expect(h.api.invalidSignatures).toBe(0);
  });

  it('처음 연결할 때는 보충 조회를 하지 않고, 체결 규칙이 없는 심볼은 조회하지 않는다', async () => {
    const h = make({}, { fillSymbols: [] });
    await start(h);
    h.api.dropAll();
    await tick(1000);
    expect(h.api.callsTo('/fapi/v1/userTrades')).toHaveLength(0);
    const first = make();
    await start(first);
    expect(first.api.callsTo('/fapi/v1/userTrades')).toHaveLength(0);
  });

  it('절전 복귀(reconnectNow)에서도 끊긴 구간의 체결을 보충한다', async () => {
    const h = make();
    await start(h);
    await tick(30_000);
    h.api.trades = [trade(9, T0 + 40_000)];
    h.feed.reconnectNow();
    await tick(0);
    expect(h.of('account.fill').map((f) => f.tradeId)).toEqual([9]);
  });

  it('보충 조회가 키 거부면 멈추고, 요청 한도·서버 오류면 로그만 남기고 계속한다', async () => {
    const h = make();
    await start(h);
    h.api.dropAll();
    await tick(1000);
    expect(h.feed.status.state).toBe('open');
    h.api.queueByPath['/fapi/v1/userTrades'] = [new Response('{}', { status: 500 })];
    h.api.dropAll();
    await tick(1000);
    expect(h.onFatal).not.toHaveBeenCalled();
    h.api.dropAll();
    h.api.queueByPath['/fapi/v1/userTrades'] = [new Response(JSON.stringify({ code: -2015, msg: 'x' }), { status: 401 })];
    await tick(1000);
    expect(h.onFatal).toHaveBeenCalledWith('userTrades rejected');
  });
});

describe('선물 계정 연결: 키 문제 (FR-KEY-02, FR-KEY-04, D-42)', () => {
  it('키를 쓸 수 없다고 판정되면(권한 위반 등) 연결하지 않고 멈춘다', async () => {
    const h = make();
    h.state.authorize = async () => ({ ok: false, retry: false, detail: 'permissions: enableFutures' });
    await start(h);
    expect(h.onFatal).toHaveBeenCalledWith('permissions: enableFutures');
    expect(h.api.fetch).not.toHaveBeenCalled();
    expect(h.api.sockets).toHaveLength(0);
    expect(h.feed.status.state).toBe('closed');
  });

  it('일시적인 확인 실패는 백오프로 다시 확인한다', async () => {
    const h = make();
    let n = 0;
    const real = h.state.authorize;
    h.state.authorize = async () => (++n < 3 ? { ok: false, retry: true, detail: 'network' } : real());
    await start(h);
    expect(h.feed.status.state).toBe('retrying');
    await tick(1000 + 2000);
    expect(h.feed.status.state).toBe('open');
    expect(n).toBe(3);
  });

  it('listenKey 발급이 키 거부로 돌아오면(-2015) 멈추고 알린다', async () => {
    const h = make();
    h.api.queue.push(new Response(JSON.stringify({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action' }), { status: 401 }));
    await start(h);
    expect(h.onFatal).toHaveBeenCalledWith(expect.stringContaining('listenKey request rejected'));
    expect(h.api.sockets).toHaveLength(0);
  });

  it('포지션 조회가 키 거부로 돌아오면 멈추고, 요청 한도·서버 오류는 로그만 남기고 계속한다', async () => {
    const h = make();
    await start(h);
    h.api.queue.push(new Response('{}', { status: 429 }), new Response('{}', { status: 500 }));
    await tick(15_000);
    await tick(15_000);
    expect(h.onFatal).not.toHaveBeenCalled();
    expect(h.feed.status.state).toBe('open');
    h.api.queue.push(new Response(JSON.stringify({ code: -2015, msg: 'x' }), { status: 401 }));
    await tick(15_000);
    expect(h.onFatal).toHaveBeenCalledWith('positionRisk rejected');
    expect(h.feed.status.state).toBe('closed');
  });

  it('발급이 일시적으로 실패하면(서버 오류) 키 문제가 아니므로 백오프로 다시 시도한다', async () => {
    const h = make();
    h.api.queue.push(new Response('{}', { status: 503 }));
    await start(h);
    expect(h.feed.status.state).toBe('retrying');
    await tick(1000);
    expect(h.feed.status.state).toBe('open');
    expect(h.onFatal).not.toHaveBeenCalled();
  });
});

describe('선물 계정 연결: 안전 (NFR-SEC-01, NFR-SEC-02, AC-41)', () => {
  it('AC-41 바이낸스 도메인이 아닌 주소로는 요청도 연결도 하지 않는다', async () => {
    const h = make({ endpoints: { rest: 'https://evil.example.com', wsPrivate: 'wss://evil.example.com/private/ws' } });
    await start(h);
    expect(h.api.fetch).not.toHaveBeenCalled();
    expect(h.api.sockets).toHaveLength(0);
    expect(h.feed.status.state).toBe('retrying');
  });

  it('AC-41 선물 데모 주소는 테스트넷 모드에서만 허용된다', async () => {
    const mainnet = make({ endpoints: FUTURES_ACCOUNT_ENDPOINTS.testnet }); // 모드가 mainnet인데 데모 주소를 쓰려 함
    await start(mainnet);
    expect(mainnet.api.fetch).not.toHaveBeenCalled();
    expect(mainnet.api.sockets).toHaveLength(0);

    const testnet = make({ mode: 'testnet' });
    testnet.api.positions = [long()];
    await start(testnet);
    expect(testnet.api.callsTo('/fapi/v1/listenKey', 'POST')[0]!.origin).toBe('https://demo-fapi.binance.com');
    expect(testnet.api.sockets[0]!.url.startsWith('wss://demo-fstream.binance.com/private/ws?listenKey=')).toBe(true);
  });

  it('NFR-SEC-01 로그에 API 키·listenKey·서명이 남지 않는다', async () => {
    const h = make();
    h.api.positions = [long()];
    await start(h);
    h.api.expireNextKeepalive = true;
    await tick(5 * 60_000);
    await tick(1000);
    h.api.refuseSockets = true;
    h.api.dropAll();
    await tick(2000);
    const text = h.logs.join('\n');
    expect(text).not.toContain(FAKE_API_KEY);
    expect(text).not.toMatch(/LK-\d/);
    expect(text).not.toMatch(/signature=/);
  });

  it('stop은 타이머와 소켓을 모두 정리한다', async () => {
    const h = make();
    await start(h);
    h.feed.stop();
    expect(h.api.sockets[0]!.closed).toBe(true);
    const calls = h.api.fetch.mock.calls.length;
    await tick(2 * 60 * 60_000);
    expect(h.api.fetch.mock.calls.length).toBe(calls);
    expect(h.feed.status.state).toBe('closed');
  });
});
