import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BinanceFeed, planSubscriptions, type StreamPlan } from '../../src/binance/index.js';
import { ROTATE_AFTER_MS, WATCHDOG_IDLE_MS } from '../../src/binance/connection.js';
import { ALLOWED_HOSTS, ENDPOINTS } from '../../src/binance/endpoints.js';
import { Engine } from '../../src/engine/index.js';
import { EventBus } from '../../src/shared/bus.js';
import { Logger } from '../../src/shared/logger.js';
import { iso } from '../../src/shared/clock.js';
import type { BlertEvent } from '../../src/shared/events.js';
import type { Rule } from '../../src/shared/types.js';
import { FakeNetwork, klineMsg, klineRows, markPrice, miniTicker } from './fakeNetwork.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 3, 0, 0, 0) + 30_000; // 00:00:30 — 분의 중간
const NOW_MIN = Math.floor(T0 / MIN) * MIN;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const spot = (symbol = 'BTCUSDT', extra: Partial<StreamPlan> = {}): StreamPlan => ({
  market: 'spot', symbol, ticker: true, kline: false, funding: false, backfillMs: 0, ...extra,
});
const futures = (symbol = 'BTCUSDT', extra: Partial<StreamPlan> = {}): StreamPlan => ({
  market: 'futures', symbol, ticker: false, kline: false, funding: true, backfillMs: 0, ...extra,
});

/** URL의 startTime부터 지금(분 단위)까지 limit개 이내의 1분봉을 돌려주는 가짜 REST */
function klineFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const start = Number(url.searchParams.get('startTime'));
    const limit = Number(url.searchParams.get('limit'));
    const count = Math.max(0, Math.min(limit, Math.floor((Math.floor(Date.now() / MIN) * MIN - start) / MIN) + 1));
    return new Response(JSON.stringify(klineRows(start, count)), { status: 200 });
  });
}

/** 긴 시간을 건너뛰되 1분마다 시세를 흘려 무응답 감시가 끼어들지 않게 한다 */
async function advanceWithTraffic(net: FakeNetwork, ms: number): Promise<void> {
  for (let left = ms; left > 0; ) {
    const step = Math.min(left, MIN);
    await tick(step);
    left -= step;
    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 100));
  }
}

function setup(opts: Partial<ConstructorParameters<typeof BinanceFeed>[0]> = {}) {
  const bus = new EventBus();
  const events: BlertEvent[] = [];
  for (const t of ['market.ticker', 'market.kline', 'market.funding', 'conn.status', 'conn.gap', 'rule.fired'] as const) {
    bus.on(t, (e) => events.push(e));
  }
  const net = new FakeNetwork();
  const logs: string[] = [];
  const logger = new Logger({ write: (l) => logs.push(l) }, 'debug');
  const fetchFn = vi.fn(async () => {
    throw new Error('unexpected fetch');
  });
  const feed = new BinanceFeed({
    bus, wsFactory: net.factory, logger, clock: { now: () => Date.now() },
    fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {}, ...opts,
  });
  const of = <T extends BlertEvent['type']>(type: T) => events.filter((e) => e.type === type) as Extract<BlertEvent, { type: T }>[];
  return { bus, events, net, logs, feed, of };
}

let feeds: BinanceFeed[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  for (const f of feeds) f.stop();
  feeds = [];
  vi.useRealTimers();
});
const make = (opts: Parameters<typeof setup>[0] = {}) => {
  const h = setup(opts);
  feeds.push(h.feed);
  return h;
};

describe('binance 스트림 수신 (FR-ALERT-01~04 데이터)', () => {
  it('현물·선물 연결은 문서의 엔드포인트로 붙고 필요한 스트림만 구독한다', async () => {
    const { feed, net } = make();
    feed.update([spot('BTCUSDT', { kline: true }), futures('ETHUSDT', { ticker: true })]);
    await tick(0);
    const urls = Object.fromEntries(net.sockets.map((s) => [s.url, [...s.subscribed].sort()]));
    expect(urls).toEqual({
      'wss://stream.binance.com:9443/stream': ['btcusdt@kline_1m', 'btcusdt@miniTicker'],
      'wss://fstream.binance.com/market/stream': ['ethusdt@markPrice', 'ethusdt@miniTicker'],
    });
  });

  it('miniTicker·kline·markPrice 메시지를 내부 이벤트로 바꿔 발행한다', async () => {
    const { feed, net, of } = make();
    feed.update([spot('BTCUSDT', { kline: true }), futures('BTCUSDT', { ticker: true })]);
    await tick(0);
    const spotSock = net.sockets.find((s) => s.url.includes('stream.binance.com'))!;
    spotSock.serverSend({ stream: 'btcusdt@miniTicker', data: miniTicker('BTCUSDT', 70012.5, 123456.7) });
    spotSock.serverSend({ stream: 'btcusdt@kline_1m', data: klineMsg('BTCUSDT', NOW_MIN, 70010, 5000.25, false) });
    const futSock = net.sockets.find((s) => s.url.includes('fstream'))!;
    futSock.serverSend({ stream: 'btcusdt@miniTicker', data: miniTicker('BTCUSDT', 70100, 9) });
    futSock.serverSend({ stream: 'btcusdt@markPrice', data: markPrice('BTCUSDT', 0.0006, NOW_MIN + 8 * HOUR) });

    expect(of('market.ticker')).toEqual([
      { type: 'market.ticker', ts: iso(T0), market: 'spot', symbol: 'BTCUSDT', price: 70012.5, quoteVolume: 123456.7 },
      { type: 'market.ticker', ts: iso(T0), market: 'futures', symbol: 'BTCUSDT', price: 70100, quoteVolume: 9 },
    ]);
    expect(of('market.kline')[0]).toMatchObject({ market: 'spot', openTime: iso(NOW_MIN), close: 70010, quoteVolume: 5000.25, closed: false });
    expect(of('market.funding')).toEqual([
      { type: 'market.funding', ts: iso(T0), symbol: 'BTCUSDT', rate: 0.0006, nextFundingTime: iso(NOW_MIN + 8 * HOUR) },
    ]);
  });

  it('형식이 다른 메시지는 이벤트로 만들지 않고 경고를 남긴다', async () => {
    const { feed, net, of, logs } = make();
    feed.update([spot()]);
    await tick(0);
    net.sockets[0]!.serverSend({ stream: 'btcusdt@miniTicker', data: { s: 'BTCUSDT', c: 'abc', q: '1' } });
    net.sockets[0]!.onmessage?.({ data: 'not json' });
    expect(of('market.ticker')).toHaveLength(0);
    expect(logs.join('\n')).toContain('unexpected message');
  });

  it('구독 목록이 바뀌면 추가·삭제분만 SUBSCRIBE/UNSUBSCRIBE로 보낸다 (B5 규칙 변경)', async () => {
    const { feed, net } = make();
    feed.update([spot('BTCUSDT')]);
    await tick(0);
    feed.update([spot('BTCUSDT'), spot('ETHUSDT')]);
    await tick(300);
    feed.update([spot('ETHUSDT')]);
    await tick(300);
    const msgs = net.sockets[0]!.sent.map((m) => [m.method, m.params]);
    expect(msgs).toEqual([
      ['SUBSCRIBE', ['btcusdt@miniTicker']],
      ['SUBSCRIBE', ['ethusdt@miniTicker']],
      ['UNSUBSCRIBE', ['btcusdt@miniTicker']],
    ]);
    expect(net.sockets).toHaveLength(1); // 재연결 없이 갱신
  });

  it('구독 메시지는 100개씩 나눠 250ms 간격으로 보내 수신 한도를 넘지 않는다', async () => {
    const { feed, net } = make();
    feed.update(Array.from({ length: 250 }, (_, i) => spot(`C${i}USDT`)));
    await tick(0);
    const sock = net.sockets[0]!;
    expect(sock.sent.map((m) => m.params.length)).toEqual([100]);
    await tick(250);
    expect(sock.sent.map((m) => m.params.length)).toEqual([100, 100]);
    await tick(250);
    expect(sock.sent.map((m) => m.params.length)).toEqual([100, 100, 50]);
  });

  it('선물 스트림이 연결당 한도(190)를 넘으면 연결을 나눈다', async () => {
    const { feed, net } = make();
    feed.update(Array.from({ length: 250 }, (_, i) => futures(`C${i}USDT`)));
    await tick(2000);
    expect(net.sockets).toHaveLength(2);
    expect(net.sockets.map((s) => s.subscribed.size).sort((a, b) => a - b)).toEqual([60, 190]);
    expect(feed.status.map((s) => s.stream)).toEqual(['futures', 'futures#2']);
  });

  it('구독할 것이 없어진 시장은 연결을 닫는다', async () => {
    const { feed, net, of } = make();
    feed.update([spot()]);
    await tick(0);
    feed.update([]);
    expect(net.sockets[0]!.closed).toBe(true);
    expect(of('conn.status').at(-1)).toMatchObject({ stream: 'spot', state: 'closed' });
  });
});

describe('binance 재연결 (FR-CONN-01, NFR-REL-01)', () => {
  it('AC-22 연결이 끊기면 1초부터 2배씩, 최대 60초 간격으로 재시도한다', async () => {
    const { feed, net, of } = make();
    net.refuse = true;
    feed.update([spot()]);
    await tick(400_000);
    const times = net.sockets.map((s) => s.createdAt - T0);
    const gaps = times.slice(1, 10).map((t, i) => (t - times[i]!) / 1000);
    expect(gaps).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
    const retrying = of('conn.status').filter((e) => e.state === 'retrying');
    expect(retrying.slice(0, 8).map((e) => e.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('AC-22 5분 넘게 끊기면 지속 중인 끊김을 알리고, 복구되면 끊긴 구간 전체를 알린다', async () => {
    const { feed, net, of } = make();
    feed.update([spot()]);
    await tick(0);
    expect(of('conn.status').at(-1)).toMatchObject({ state: 'open', attempt: 0 });

    const dropAt = Date.now();
    net.refuse = true;
    net.dropAll();
    await tick(5 * MIN - 1);
    expect(of('conn.gap')).toHaveLength(0);
    await tick(1);
    expect(of('conn.gap')).toEqual([
      expect.objectContaining({ from: iso(dropAt), to: iso(dropAt + 5 * MIN), reason: 'disconnect', ongoing: true }),
    ]);
    expect(of('conn.status').at(-1)?.state).toBe('retrying'); // 아직 끊겨 있음

    net.refuse = false;
    await tick(61_000);
    const gaps = of('conn.gap');
    expect(gaps).toHaveLength(2);
    expect(gaps[1]).toMatchObject({ from: iso(dropAt), reason: 'disconnect' });
    expect(gaps[1]!.ongoing).toBeUndefined(); // 끝난 구간
    expect(Date.parse(gaps[1]!.to)).toBeGreaterThan(dropAt + 5 * MIN);
    expect(of('conn.status').at(-1)).toMatchObject({ state: 'open', attempt: 0 });
  });

  it('5분 안에 복구되면 경고 없이 끊긴 구간만 한 번 알리고, 다음 끊김은 다시 1초부터 시작한다', async () => {
    const { feed, net, of } = make();
    feed.update([spot()]);
    await tick(0);
    net.dropAll();
    await tick(1000);
    expect(of('conn.gap')).toHaveLength(1);
    expect(net.live).toHaveLength(1);

    net.refuse = true;
    net.dropAll();
    const before = net.sockets.length;
    await tick(999);
    expect(net.sockets).toHaveLength(before);
    await tick(1);
    expect(net.sockets).toHaveLength(before + 1);
  });

  it('재연결하면 같은 스트림을 다시 구독하고 데이터가 이어진다', async () => {
    const { feed, net, of } = make();
    feed.update([spot()]);
    await tick(0);
    net.dropAll();
    await tick(1000);
    expect([...net.live[0]!.subscribed]).toEqual(['btcusdt@miniTicker']);
    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 100));
    expect(of('market.ticker')).toHaveLength(1);
  });

  it('AC-21 절전 복귀: reconnectAll은 끊김 알림 없이 즉시 다시 연결한다', async () => {
    const { feed, net, of } = make();
    feed.update([spot(), futures()]);
    await tick(0);
    feed.reconnectAll();
    await tick(0);
    expect(net.sockets).toHaveLength(4);
    expect(net.sockets.slice(0, 2).every((s) => s.closed)).toBe(true);
    expect(net.live).toHaveLength(2);
    expect(of('conn.gap')).toHaveLength(0); // 절전 구간은 runtime이 알린다
    expect(of('conn.status').at(-1)).toMatchObject({ state: 'open', attempt: 0 });
  });

  it('메시지가 3분 넘게 없으면 반쯤 끊긴 연결로 보고 다시 연결하며 그 구간을 알린다', async () => {
    const { feed, net, of, logs } = make();
    feed.update([spot()]);
    await tick(0);
    const openedAt = Date.now();
    await tick(WATCHDOG_IDLE_MS + 40_000);
    expect(net.sockets).toHaveLength(2);
    expect(logs.join('\n')).toContain('no messages');
    expect(of('conn.gap')[0]).toMatchObject({ from: iso(openedAt), reason: 'disconnect' });
  });

  it('메시지가 계속 오면 감시에 걸리지 않는다', async () => {
    const { feed, net } = make();
    feed.update([spot()]);
    await tick(0);
    for (let i = 0; i < 20; i++) {
      await tick(60_000);
      net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 100));
    }
    expect(net.sockets).toHaveLength(1);
  });

  it('stop하면 연결을 닫고 더 이상 재시도하지 않는다', async () => {
    const { feed, net, of } = make();
    net.refuse = true;
    feed.update([spot()]);
    await tick(1500);
    const n = net.sockets.length;
    feed.stop();
    await tick(10 * MIN);
    expect(net.sockets).toHaveLength(n);
    expect(of('conn.status').at(-1)?.state).toBe('closed');
  });
});

describe('binance 24시간 만료 (B5)', () => {
  it('만료 10분 전에 새 연결을 열고 구독 확인 뒤에 옛 연결을 닫는다. 중복 이벤트도 끊김도 없다', async () => {
    const { feed, net, of } = make();
    feed.update([spot()]);
    await tick(0);
    await advanceWithTraffic(net, ROTATE_AFTER_MS - 1);
    expect(net.sockets).toHaveLength(1);

    net.autoAck = false;
    await tick(1);
    expect(net.sockets).toHaveLength(2);
    const [old, fresh] = net.sockets as [(typeof net.sockets)[number], (typeof net.sockets)[number]];
    expect(fresh.sent[0]).toMatchObject({ method: 'SUBSCRIBE', params: ['btcusdt@miniTicker'] });
    expect(old.closed).toBe(false);

    const base = of('market.ticker').length;
    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 100)); // 두 연결이 같은 데이터를 받아도
    expect(of('market.ticker')).toHaveLength(base + 1); // 옛 연결 것만 쓴다

    fresh.ack(fresh.sent[0]!.id);
    await tick(0);
    expect(old.closed).toBe(true);
    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 101));
    expect(of('market.ticker')).toHaveLength(base + 2);
    expect(of('conn.status').some((e) => e.state === 'retrying')).toBe(false);
    expect(of('conn.gap')).toHaveLength(0);

    // 다음 만료 때도 반복된다
    net.autoAck = true;
    await advanceWithTraffic(net, ROTATE_AFTER_MS);
    expect(net.sockets).toHaveLength(3);
    expect(net.sockets[1]!.closed).toBe(true);
  });

  it('교체 연결이 구독 확인을 못 받으면 버리고 1분 뒤 다시 시도하며 옛 연결은 유지한다', async () => {
    const { feed, net, of } = make();
    feed.update([spot()]);
    await tick(0);
    await advanceWithTraffic(net, ROTATE_AFTER_MS - 1);
    net.autoAck = false;
    await tick(1);
    expect(net.sockets).toHaveLength(2);
    await tick(16_000); // 확인 대기 15초 초과
    expect(net.sockets[1]!.closed).toBe(true);
    expect(net.sockets[0]!.closed).toBe(false);
    const base = of('market.ticker').length;
    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 100));
    expect(of('market.ticker')).toHaveLength(base + 1);
    net.autoAck = true;
    await tick(60_000);
    expect(net.sockets).toHaveLength(3);
    await tick(0);
    expect(net.sockets[0]!.closed).toBe(true); // 이번에는 교체 성공
  });
});

describe('binance REST 백필 (D-33)', () => {
  const change = (market: 'spot' | 'futures' = 'spot', backfillMs = 62 * MIN): StreamPlan => ({
    market, symbol: 'BTCUSDT', ticker: true, kline: true, funding: false, backfillMs,
  });

  it('시작하면 필요한 기간(+여유 2분)의 1분봉을 시간순 market.kline으로 발행한다', async () => {
    const fetchFn = klineFetch();
    const { feed, of } = make({ fetchFn: fetchFn as unknown as typeof fetch });
    feed.update([change()]);
    await tick(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchFn.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://api.binance.com/api/v3/klines');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ symbol: 'BTCUSDT', interval: '1m', startTime: String(NOW_MIN - 62 * MIN) });

    const klines = of('market.kline');
    expect(klines).toHaveLength(63);
    expect(klines.map((k) => Date.parse(k.openTime))).toEqual(Array.from({ length: 63 }, (_, i) => NOW_MIN - 62 * MIN + i * MIN));
    expect(klines.slice(0, -1).every((k) => k.closed)).toBe(true);
    expect(klines.at(-1)!.closed).toBe(false); // 진행 중인 분
    expect(klines[0]).toMatchObject({ close: 1000, quoteVolume: 1000, symbol: 'BTCUSDT', market: 'spot' });
  });

  it('선물은 fapi 엔드포인트를 쓴다', async () => {
    const fetchFn = klineFetch();
    const { feed } = make({ fetchFn: fetchFn as unknown as typeof fetch });
    feed.update([change('futures')]);
    await tick(0);
    const url = new URL(String(fetchFn.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://fapi.binance.com/fapi/v1/klines');
    expect(url.searchParams.get('limit')).toBe('1500');
  });

  it('한 번에 다 못 받는 24시간 구간은 이어서 받는다', async () => {
    const fetchFn = klineFetch();
    const { feed, of } = make({ fetchFn: fetchFn as unknown as typeof fetch });
    feed.update([change('spot', 24 * HOUR + 2 * MIN)]);
    await tick(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const starts = fetchFn.mock.calls.map((c) => Number(new URL(String(c[0])).searchParams.get('startTime')));
    expect(starts[1]).toBe(starts[0]! + 1000 * MIN);
    expect(of('market.kline')).toHaveLength(24 * 60 + 3);
  });

  it('이미 받은 구간은 다시 받지 않고, 더 긴 구간이 필요해질 때만 다시 받는다', async () => {
    const fetchFn = klineFetch();
    const { feed } = make({ fetchFn: fetchFn as unknown as typeof fetch });
    feed.update([change()]);
    await tick(0);
    feed.update([change()]);
    await tick(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    feed.update([change('spot', 3 * HOUR)]);
    await tick(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('없는 심볼(HTTP 400)은 경고만 남기고 같은 계획으로 다시 요청하지 않는다', async () => {
    const fetchFn = vi.fn(async () => new Response('{"code":-1121,"msg":"Invalid symbol."}', { status: 400 }));
    const { feed, of, logs } = make({ fetchFn: fetchFn as unknown as typeof fetch });
    feed.update([change()]);
    await tick(0);
    feed.update([change()]);
    await tick(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(of('market.kline')).toHaveLength(0);
    expect(logs.join('\n')).toContain('invalid symbol');
  });

  it('재연결되면 마지막으로 본 분봉부터 다시 채운다', async () => {
    const fetchFn = klineFetch();
    const { feed, net } = make({ fetchFn: fetchFn as unknown as typeof fetch });
    feed.update([change()]);
    await tick(0);
    net.dropAll();
    await tick(2000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(Number(new URL(String(fetchFn.mock.calls[1]![0])).searchParams.get('startTime'))).toBe(NOW_MIN);
  });

  it('규칙이 변동률·거래량이 아니면 백필하지 않는다', async () => {
    const { feed, of } = make();
    feed.update([spot(), futures()]);
    await tick(0);
    expect(of('market.kline')).toHaveLength(0);
  });
});

describe('binance 네트워크 제한 (NFR-SEC-02, AC-23)', () => {
  it('바이낸스 도메인이 아니면 연결하지 않고 재시도 상태로 남는다', async () => {
    const { feed, net, logs, of } = make({
      endpoints: { ws: { spot: 'wss://evil.example.com/stream', futures: ENDPOINTS.ws.futures }, rest: ENDPOINTS.rest },
    });
    feed.update([spot()]);
    await tick(0);
    expect(net.sockets).toHaveLength(0);
    expect(of('conn.status').at(-1)?.state).toBe('retrying');
    expect(logs.join('\n')).toContain('blocked connection');
  });

  it('REST 주소가 바이낸스 도메인이 아니면 요청을 보내지 않는다', async () => {
    const fetchFn = vi.fn();
    const { feed, logs } = make({
      fetchFn: fetchFn as unknown as typeof fetch,
      endpoints: { ws: ENDPOINTS.ws, rest: { spot: 'https://evil.example.com/klines', futures: ENDPOINTS.rest.futures } },
    });
    feed.update([{ market: 'spot', symbol: 'BTCUSDT', ticker: false, kline: true, funding: false, backfillMs: 5 * MIN }]);
    await tick(0);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('blocked request');
  });

  it('AC-23 감시하는 동안 만든 모든 연결·요청은 바이낸스 도메인이다', async () => {
    const fetchFn = klineFetch();
    const { feed, net } = make({ fetchFn: fetchFn as unknown as typeof fetch });
    feed.update([
      spot('BTCUSDT', { kline: true, backfillMs: 62 * MIN }),
      futures('BTCUSDT', { kline: true, backfillMs: 62 * MIN }),
    ]);
    await tick(0);
    net.dropAll();
    await tick(ROTATE_AFTER_MS + 10_000);
    const hosts = [...net.sockets.map((s) => s.url), ...fetchFn.mock.calls.map((c) => String(c[0]))].map((u) => new URL(u).hostname);
    expect(hosts.length).toBeGreaterThan(4);
    expect(hosts.every((h) => ALLOWED_HOSTS.includes(h))).toBe(true);
  });
});

describe('binance 구독 계획', () => {
  const rule = (condition: Rule['condition'], symbol = 'BTCUSDT', market: Rule['market'] = 'spot', enabled = true): Rule => ({
    id: 1, type: condition.type, market, symbol, condition, repeat: { kind: 'once' }, source: 'manual', enabled, createdAt: '',
  });

  it('규칙 유형별로 필요한 스트림과 백필 기간을 계산한다', () => {
    const plan = planSubscriptions([
      rule({ type: 'price', direction: 'above', price: 1 }),
      rule({ type: 'change', pct: 5, windowMs: HOUR, direction: 'both' }, 'ETHUSDT'),
      rule({ type: 'volume', multiple: 3, shortMs: 5 * MIN, longMs: 2 * HOUR }, 'ETHUSDT'),
      rule({ type: 'funding', direction: 'above', pct: 0.05 }, 'BTCUSDT', 'futures'),
      rule({ type: 'price', direction: 'above', price: 1 }, 'XRPUSDT', 'spot', false),
    ]);
    expect(plan).toEqual([
      { market: 'spot', symbol: 'BTCUSDT', ticker: true, kline: false, funding: false, backfillMs: 0 },
      { market: 'spot', symbol: 'ETHUSDT', ticker: true, kline: true, funding: false, backfillMs: 2 * HOUR + 2 * MIN },
      { market: 'futures', symbol: 'BTCUSDT', ticker: false, kline: false, funding: true, backfillMs: 0 },
    ]);
  });
});

describe('binance + engine 통합', () => {
  it('AC-10 백필한 이력과 실시간 시세로 시작 직후부터 변동률 알림이 발동한다', async () => {
    const fetchFn = klineFetch();
    const { feed, bus, net, of } = make({ fetchFn: fetchFn as unknown as typeof fetch });
    const engine = new Engine();
    engine.setRules([
      { id: 1, type: 'change', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'change', pct: 5, windowMs: HOUR, direction: 'up' },
        repeat: { kind: 'cooldown', ms: 30 * MIN }, source: 'manual', enabled: true, createdAt: '' },
    ]);
    engine.attach(bus);
    feed.update([{ market: 'spot', symbol: 'BTCUSDT', ticker: true, kline: true, funding: false, backfillMs: 62 * MIN }]);
    await tick(0);
    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 1040));
    expect(of('rule.fired')).toHaveLength(0);
    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 1060));
    expect(of('rule.fired')).toHaveLength(1);
    expect(of('rule.fired')[0]!.alert.params).toMatchObject({ from: '1,000', to: '1,060', pct: '+6.0%' });
  });

  it('AC-11 백필한 과거의 거래량 급증은 시작할 때 새 알림으로 울리지 않는다', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const start = Number(new URL(String(input)).searchParams.get('startTime'));
      const rows = klineRows(start, 63, 1000, 1000);
      for (const i of [10, 11, 12, 13, 14]) rows[i]![7] = '900000'; // 50분 전쯤의 큰 거래량
      return new Response(JSON.stringify(rows), { status: 200 });
    });
    const { feed, bus, net, of } = make({ fetchFn: fetchFn as unknown as typeof fetch });
    const engine = new Engine();
    engine.setRules([
      { id: 1, type: 'volume', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'volume', multiple: 3, shortMs: 5 * MIN, longMs: HOUR },
        repeat: { kind: 'cooldown', ms: 15 * MIN }, source: 'manual', enabled: true, createdAt: '' },
    ]);
    engine.attach(bus);
    feed.update([{ market: 'spot', symbol: 'BTCUSDT', ticker: false, kline: true, funding: false, backfillMs: 62 * MIN }]);
    await tick(0);
    expect(of('rule.fired')).toHaveLength(0);

    net.push('btcusdt@kline_1m', klineMsg('BTCUSDT', NOW_MIN, 1000, 1000, false)); // 평소 수준
    expect(of('rule.fired')).toHaveLength(0);
    net.push('btcusdt@kline_1m', klineMsg('BTCUSDT', NOW_MIN, 1000, 30_000_000, false)); // 지금 폭증
    expect(of('rule.fired')).toHaveLength(1);
  });
});
