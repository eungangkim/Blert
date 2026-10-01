import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountFeed, type AccountWants, type AuthorizeResult } from '../../src/binance/index.js';
import { ROTATE_AFTER_MS } from '../../src/binance/connection.js';
import { ACCOUNT_ENDPOINTS } from '../../src/binance/endpoints.js';
import { EventBus } from '../../src/shared/bus.js';
import { Logger } from '../../src/shared/logger.js';
import { iso } from '../../src/shared/clock.js';
import type { BlertEvent } from '../../src/shared/events.js';
import { credentialsFrom } from '../../src/security/index.js';
import { FAKE_API_KEY, makeEd25519 } from '../security/helpers.js';
import { FakeAccountRest, FakeApiServer, accountPosition, executionReport } from './fakeApi.js';

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function setup(extra: Partial<ConstructorParameters<typeof AccountFeed>[0]> = {}, wantsInit: Partial<AccountWants> = {}) {
  const bus = new EventBus();
  const events: BlertEvent[] = [];
  for (const t of ['account.fill', 'account.balance', 'conn.status', 'conn.gap'] as const) bus.on(t, (e) => events.push(e));
  const key = makeEd25519();
  const server = new FakeApiServer(key.publicKey, FAKE_API_KEY);
  const rest = new FakeAccountRest(key.publicKey, FAKE_API_KEY);
  rest.balances = [
    { asset: 'USDT', free: 1000, locked: 0 },
    { asset: 'BTC', free: 0.5, locked: 0 },
    { asset: 'ETH', free: 2, locked: 0 },
    { asset: 'DOGE', free: 0, locked: 0 },
  ];
  const creds = credentialsFrom({ apiKey: FAKE_API_KEY, privateKeyPem: key.pem });
  const state = {
    authorize: (async (): Promise<AuthorizeResult> => ({ ok: true, credentials: creds })) as () => Promise<AuthorizeResult>,
    wants: { balances: true, fills: true, allFills: true, fillSymbols: [], ...wantsInit } as AccountWants,
  };
  const authorizeSpy = vi.fn(() => state.authorize());
  const logs: string[] = [];
  const sleep = vi.fn(async (_ms: number) => {});
  const onFatal = vi.fn();
  const feed = new AccountFeed({
    bus, authorize: authorizeSpy, wants: () => state.wants, onFatal, sleep,
    clock: { now: () => Date.now() }, logger: new Logger({ write: (l) => logs.push(l) }, 'debug'),
    wsFactory: server.factory, fetchFn: rest.fetchFn, ...extra,
  });
  const of = <T extends BlertEvent['type']>(type: T) => events.filter((e) => e.type === type) as Extract<BlertEvent, { type: T }>[];
  return { feed, bus, events, of, key, server, rest, state, authorizeSpy, logs, sleep, onFatal };
}

let feeds: AccountFeed[] = [];
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

describe('account 연결과 이벤트 변환 (FR-ACC-01~02, D-06)', () => {
  it('session.logon을 Ed25519로 서명해 로그인한 뒤 userDataStream.subscribe로 구독하고, 잔고 스냅샷으로 기준을 낸다', async () => {
    const h = make();
    await start(h);
    const sock = h.server.sockets[0]!;
    expect(sock.url).toBe('wss://ws-api.binance.com:443/ws-api/v3');
    expect(sock.requests.map((r) => r.method)).toEqual(['session.logon', 'userDataStream.subscribe']); // listenKey 없음
    expect(h.server.logons[0]).toMatchObject({ apiKey: FAKE_API_KEY, timestamp: T0, valid: true, keys: ['apiKey', 'signature', 'timestamp'] });
    expect(h.feed.status).toEqual({ stream: 'account', state: 'open', attempt: 0 });
    expect(h.of('account.balance').map((b) => [b.asset, b.free + b.locked])).toEqual([['USDT', 1000], ['BTC', 0.5], ['ETH', 2], ['DOGE', 0]]);
    expect(h.rest.invalidSignatures).toBe(0);
  });

  it('AC-31 executionReport는 x가 TRADE일 때만 account.fill로 바꾸고, 같은 체결 ID는 한 번만 알린다', async () => {
    const h = make();
    await start(h);
    h.server.event(executionReport({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.1, price: 68000, orderId: 7, tradeId: 0, type: 'NEW' }));
    h.server.event(executionReport({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.1, price: 68000, orderId: 7, tradeId: 0, type: 'CANCELED' }));
    expect(h.of('account.fill')).toHaveLength(0);

    h.server.event(executionReport({ symbol: 'BTCUSDT', side: 'BUY', qty: '0.01500000', price: '68420.00000000', orderId: 123, tradeId: 456 }));
    h.server.event(executionReport({ symbol: 'BTCUSDT', side: 'BUY', qty: '0.01500000', price: '68420.00000000', orderId: 123, tradeId: 456 })); // 중복
    h.server.event(executionReport({ symbol: 'ETHUSDT', side: 'SELL', qty: 2, price: 3412.5, orderId: 124, tradeId: 9 }));
    expect(h.of('account.fill')).toEqual([
      { type: 'account.fill', ts: iso(T0), market: 'spot', symbol: 'BTCUSDT', side: 'BUY', qty: 0.015, price: 68420, orderId: 123, tradeId: 456 },
      { type: 'account.fill', ts: iso(T0), market: 'spot', symbol: 'ETHUSDT', side: 'SELL', qty: 2, price: 3412.5, orderId: 124, tradeId: 9 },
    ]);
  });

  it('부분 체결은 체결마다 따로 알리고, 형식이 이상한 체결은 버린다', async () => {
    const h = make();
    await start(h);
    for (const [id, qty] of [[1, 0.1], [2, 0.2], [3, 0.3]] as const) {
      h.server.event(executionReport({ symbol: 'BTCUSDT', side: 'BUY', qty, price: 70000, orderId: 5, tradeId: id }));
    }
    h.server.event({ ...executionReport({ symbol: 'BTCUSDT', side: 'BUY', qty: 1, price: 1, orderId: 5, tradeId: 4 }), L: 'abc' });
    h.server.event({ ...executionReport({ symbol: 'BTCUSDT', side: 'BUY', qty: 1, price: 1, orderId: 5, tradeId: -1 }) });
    expect(h.of('account.fill').map((f) => f.qty)).toEqual([0.1, 0.2, 0.3]);
  });

  it('outboundAccountPosition은 자산마다 account.balance로 바꾸고, 알 수 없는 이벤트는 무시한다', async () => {
    const h = make();
    await start(h);
    const before = h.of('account.balance').length;
    h.server.event(accountPosition([{ asset: 'USDT', free: 940.5, locked: 10 }, { asset: 'BTC', free: 0.5 }]));
    h.server.event({ e: 'balanceUpdate', a: 'USDT', d: '5', T: 1 });
    h.server.event({ e: 'somethingNew' });
    const added = h.of('account.balance').slice(before);
    expect(added.map((b) => [b.asset, b.free, b.locked])).toEqual([['USDT', 940.5, 10], ['BTC', 0.5, 0]]);
  });
});

describe('account 재연결과 보충 조회 (FR-CONN-02)', () => {
  it('AC-33 끊긴 사이 체결된 거래를 재연결 뒤 보충 조회해 알리고, 이미 받은 체결은 다시 알리지 않는다', async () => {
    const h = make();
    await start(h);
    h.server.event(executionReport({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.1, price: 68000, orderId: 10, tradeId: 1 })); // 실시간으로 받음
    h.rest.trades = [{ symbol: 'BTCUSDT', id: 1, orderId: 10, price: 68000, qty: 0.1, time: T0, isBuyer: true }];

    await tick(30_000);
    h.server.dropAll(); // 연결이 끊긴 동안 체결이 일어난다
    h.rest.trades.push(
      { symbol: 'BTCUSDT', id: 2, orderId: 11, price: 68100, qty: 0.2, time: T0 + 31_000, isBuyer: false },
      { symbol: 'ETHUSDT', id: 3, orderId: 12, price: 3400, qty: 1, time: T0 + 32_000, isBuyer: true },
      { symbol: 'SOLUSDT', id: 4, orderId: 13, price: 150, qty: 5, time: T0 + 33_000, isBuyer: true }, // 보유도 규칙도 아님
    );
    const callsBefore = h.rest.tradeCalls().length;
    await tick(1000); // 1초 뒤 재연결

    const fills = h.of('account.fill');
    expect(fills.map((f) => [f.symbol, f.tradeId, f.side])).toEqual([['BTCUSDT', 1, 'BUY'], ['BTCUSDT', 2, 'SELL'], ['ETHUSDT', 3, 'BUY']]);
    // 조회 대상: 보유 자산의 USDT 쌍(BTC, ETH) + 이번 실행에서 체결이 있던 심볼(BTCUSDT). USDT·잔고 0인 DOGE·SOL은 제외 (결정 2A)
    const calls = h.rest.tradeCalls().slice(callsBefore);
    expect(calls.map((c) => c.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(calls.every((c) => c.startTime === T0 - 60_000)).toBe(true); // 끊기기 직전 생존 시각(T0) − 여유 60초
    expect(h.of('conn.gap')).toHaveLength(1); // 끊긴 구간도 알린다
    expect(h.rest.invalidSignatures).toBe(0);
  });

  it('규칙에 적힌 심볼은 거래 이력이 없어도 보충 조회하고, 없는 심볼(-1121)은 조용히 건너뛴다', async () => {
    const h = make({}, { fillSymbols: ['XRPUSDT', 'ZZZUSDT'] });
    h.rest.invalidSymbols.add('ZZZUSDT');
    await start(h);
    h.rest.trades = [{ symbol: 'XRPUSDT', id: 5, orderId: 1, price: 0.5, qty: 100, time: T0 + 2000, isBuyer: true }];
    h.server.dropAll();
    await tick(1000);
    expect(h.of('account.fill').map((f) => f.symbol)).toEqual(['XRPUSDT']);
    expect(h.rest.tradeCalls().map((c) => c.symbol)).toContain('ZZZUSDT');
    expect(h.logs.join('\n')).not.toMatch(/warn.*ZZZUSDT/);
  });

  it('끊긴 사이 잔고가 바뀌었다면 재연결 스냅샷이 새 값을 내보낸다', async () => {
    const h = make();
    await start(h);
    h.rest.balances = h.rest.balances.map((b) => (b.asset === 'USDT' ? { ...b, free: 900 } : b));
    h.server.dropAll();
    await tick(1000);
    const usdt = h.of('account.balance').filter((b) => b.asset === 'USDT');
    expect(usdt.map((b) => b.free)).toEqual([1000, 900]); // 처음 기준, 재연결 뒤 새 값
  });

  it('규칙이 필요로 하지 않는 조회는 하지 않는다 (체결 규칙만, 잔고 규칙만)', async () => {
    const fillsOnly = make({}, { balances: false, allFills: false, fillSymbols: ['XRPUSDT'] });
    await start(fillsOnly);
    fillsOnly.server.dropAll();
    await tick(1000);
    expect(fillsOnly.rest.accountCalls()).toBe(0);
    expect(fillsOnly.rest.tradeCalls().map((c) => c.symbol)).toEqual(['XRPUSDT']);

    const balancesOnly = make({}, { fills: false, allFills: false });
    await start(balancesOnly);
    balancesOnly.server.dropAll();
    await tick(1000);
    expect(balancesOnly.rest.accountCalls()).toBe(2);
    expect(balancesOnly.rest.tradeCalls()).toEqual([]);
  });

  it('처음 연결할 때는 과거 체결을 보충하지 않는다', async () => {
    const h = make();
    h.rest.trades = [{ symbol: 'BTCUSDT', id: 1, orderId: 1, price: 1, qty: 1, time: T0 - 10_000, isBuyer: true }];
    await start(h);
    expect(h.rest.tradeCalls()).toEqual([]);
    expect(h.of('account.fill')).toEqual([]);
  });

  it('요청 한도(429)에는 Retry-After만큼 쉬고 다시 시도한다', async () => {
    const h = make();
    h.rest.queue = [new Response('{}', { status: 429, headers: { 'retry-after': '2' } })];
    await start(h);
    expect(h.sleep).toHaveBeenCalledWith(2000);
    expect(h.of('account.balance').length).toBeGreaterThan(0);
    expect(h.logs.join('\n')).toContain('rate limited (429)');
  });

  it('이벤트 스트림이 종료되면(eventStreamTerminated) 다시 연결한다', async () => {
    const h = make();
    await start(h);
    h.server.event({ e: 'eventStreamTerminated', E: Date.now() });
    await tick(1000);
    expect(h.server.sockets).toHaveLength(2);
    expect(h.feed.status.state).toBe('open');
  });
});

describe('account 권한 재검사 (FR-KEY-04)', () => {
  it('연결을 시도할 때마다 authorize를 다시 부른다', async () => {
    const h = make();
    await start(h);
    expect(h.authorizeSpy).toHaveBeenCalledTimes(1);
    h.server.dropAll();
    await tick(1000);
    expect(h.authorizeSpy).toHaveBeenCalledTimes(2);
  });

  it('권한을 일시적으로 확인하지 못하면 소켓을 열지 않고 1초, 2초 간격으로 다시 확인한다', async () => {
    const creds = credentialsFrom({ apiKey: FAKE_API_KEY, privateKeyPem: makeEd25519().pem });
    const h = make();
    const answers: AuthorizeResult[] = [{ ok: false, retry: true, detail: 'network' }, { ok: false, retry: true, detail: 'network' }, { ok: true, credentials: creds }];
    h.state.authorize = async () => answers.shift()!;
    h.feed.start();
    await tick(0);
    expect(h.server.sockets).toHaveLength(0);
    await tick(999);
    expect(h.authorizeSpy).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(h.authorizeSpy).toHaveBeenCalledTimes(2);
    await tick(1999);
    expect(h.authorizeSpy).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(h.authorizeSpy).toHaveBeenCalledTimes(3);
    expect(h.server.sockets).toHaveLength(1);
  });

  it('AC-30 재연결 때 권한 위반이 확인되면 이 연결만 멈추고 다시 시도하지 않는다', async () => {
    const h = make();
    await start(h);
    h.state.authorize = async () => ({ ok: false, retry: false, detail: 'trade' });
    h.server.dropAll();
    await tick(1000);
    expect(h.feed.status.state).toBe('closed');
    expect(h.onFatal).toHaveBeenCalledTimes(1);
    expect(h.onFatal).toHaveBeenCalledWith('trade');
    const sockets = h.server.sockets.length;
    await tick(10 * 60_000);
    expect(h.server.sockets).toHaveLength(sockets); // 다시 시도하지 않는다
    expect(h.authorizeSpy).toHaveBeenCalledTimes(2);
  });

  it('로그인이 거부되면(-2015, 키·허용 IP 문제) 멈추고, 일시 오류면 다시 시도한다', async () => {
    const rejected = make();
    rejected.server.logonResult = { status: 401, code: -2015 };
    await start(rejected);
    expect(rejected.feed.status.state).toBe('closed');
    expect(rejected.onFatal).toHaveBeenCalledWith(expect.stringContaining('-2015'));

    const busy = make();
    busy.server.logonResult = { status: 503, code: -1003 };
    await start(busy);
    expect(busy.feed.status.state).toBe('retrying');
    expect(busy.onFatal).not.toHaveBeenCalled();
    busy.server.logonResult = 'ok';
    await tick(1000);
    expect(busy.feed.status.state).toBe('open');
  });

  it('구독에 실패하면 다시 시도한다', async () => {
    const h = make();
    h.server.subscribeStatus = 503;
    await start(h);
    expect(h.feed.status.state).toBe('retrying');
    h.server.subscribeStatus = 200;
    await tick(1000);
    expect(h.feed.status.state).toBe('open');
  });
});

describe('account 연결 유지 (NFR-REL-01~02)', () => {
  it('끊기면 1초부터 2배씩 재시도하고, 5분 넘으면 지속 중인 끊김을 알리고, 복구되면 끊긴 구간 전체를 알린다', async () => {
    const h = make();
    await start(h);
    const dropAt = Date.now();
    h.server.refuse = true;
    h.server.dropAll();
    await tick(5 * 60_000 - 1);
    expect(h.of('conn.gap')).toHaveLength(0);
    await tick(1);
    expect(h.of('conn.gap')).toEqual([expect.objectContaining({ from: iso(dropAt), to: iso(dropAt + 5 * 60_000), reason: 'disconnect', ongoing: true })]);

    const times = h.server.sockets.slice(1).map((s) => s.opened || s.closed);
    expect(times.length).toBeGreaterThan(5);
    h.server.refuse = false;
    await tick(61_000);
    const gaps = h.of('conn.gap');
    expect(gaps).toHaveLength(2);
    expect(gaps[1]).toMatchObject({ from: iso(dropAt), reason: 'disconnect' });
    expect(gaps[1]!.ongoing).toBeUndefined();
    expect(h.of('conn.status').every((s) => s.stream === 'account')).toBe(true);
    expect(h.feed.status).toMatchObject({ state: 'open', attempt: 0 });
  });

  it('24시간 만료 10분 전에 끊김 알림 없이 다시 연결하고, 그 사이는 보충 조회로 메운다', async () => {
    const h = make();
    await start(h);
    await tick(ROTATE_AFTER_MS);
    expect(h.server.sockets).toHaveLength(2);
    expect(h.server.sockets[0]!.closed).toBe(true);
    expect(h.server.sockets[1]!.subscribed).toBe(true);
    expect(h.of('conn.gap')).toEqual([]);
    expect(h.of('conn.status').some((s) => s.state === 'retrying')).toBe(false);
    expect(h.rest.tradeCalls().length).toBeGreaterThan(0);
  });

  it('60초마다 session.status로 확인하고, 응답이 없으면 반쯤 끊긴 연결로 보고 다시 연결한다', async () => {
    const ok = make();
    await start(ok);
    await tick(5 * 60_000);
    expect(ok.server.sockets).toHaveLength(1);
    expect(ok.server.sockets[0]!.requests.filter((r) => r.method === 'session.status')).toHaveLength(5);

    const stuck = make();
    stuck.server.respondStatus = false;
    await start(stuck);
    await tick(60_000 + 15_000 - 1);
    expect(stuck.server.sockets).toHaveLength(1);
    await tick(1);
    expect(stuck.feed.status.state).toBe('retrying');
    stuck.server.respondStatus = true;
    await tick(1000);
    expect(stuck.server.sockets).toHaveLength(2);
    expect(stuck.of('conn.gap')).toHaveLength(1);
  });

  it('절전 복귀(reconnectNow)는 끊김 알림 없이 다시 연결하고 보충 조회한다', async () => {
    const h = make();
    await start(h);
    h.rest.trades = [{ symbol: 'BTCUSDT', id: 7, orderId: 1, price: 70000, qty: 1, time: T0 + 5000, isBuyer: true }];
    await tick(10_000);
    h.feed.reconnectNow();
    await tick(0);
    expect(h.server.sockets).toHaveLength(2);
    expect(h.server.sockets[0]!.closed).toBe(true);
    expect(h.of('conn.gap')).toEqual([]);
    expect(h.of('account.fill').map((f) => f.tradeId)).toEqual([7]);
  });

  it('stop하면 연결을 닫고 다시 시도하지 않는다', async () => {
    const h = make();
    await start(h);
    h.feed.stop();
    expect(h.server.sockets[0]!.closed).toBe(true);
    expect(h.feed.status.state).toBe('closed');
    await tick(10 * 60_000);
    expect(h.server.sockets).toHaveLength(1);
  });
});

describe('account 보안 (NFR-SEC-01~02)', () => {
  it('허용 목록에 없는 주소로는 연결하지 않는다. 테스트넷 주소는 실서버 모드에서 막힌다', async () => {
    const evil = make({ endpoints: { wsApi: 'wss://evil.example.com/ws', rest: 'https://api.binance.com' } });
    await start(evil);
    expect(evil.server.sockets).toHaveLength(0);
    expect(evil.feed.status.state).toBe('retrying');
    expect(evil.logs.join('\n')).toContain('blocked connection');

    const testnetInMainnet = make({ endpoints: ACCOUNT_ENDPOINTS.testnet });
    await start(testnetInMainnet);
    expect(testnetInMainnet.server.sockets).toHaveLength(0);
  });

  it('테스트넷 모드(결정 1A)에서는 테스트넷 WebSocket API와 REST 주소를 쓴다', async () => {
    const h = make({ mode: 'testnet' });
    await start(h);
    expect(h.server.sockets[0]!.url).toBe('wss://ws-api.testnet.binance.vision/ws-api/v3');
    expect(h.rest.calls[0]!.origin).toBe('https://testnet.binance.vision');
  });

  it('로그와 이벤트에 API 키·개인키·서명이 남지 않는다', async () => {
    const h = make();
    await start(h);
    h.server.event(executionReport({ symbol: 'BTCUSDT', side: 'BUY', qty: 1, price: 1, orderId: 1, tradeId: 1 }));
    h.server.dropAll();
    await tick(1000);
    const secrets = [FAKE_API_KEY, h.key.pem.split('\n')[1]!, String(h.server.logons[0]!.signature)];
    const dump = h.logs.join('\n') + JSON.stringify(h.events);
    for (const s of secrets) expect(dump).not.toContain(s);
    expect(h.logs.length).toBeGreaterThan(0);
  });
});
