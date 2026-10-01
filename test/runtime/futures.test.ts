import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, type ProcessLike } from '../../src/runtime/index.js';
import { createNotifier } from '../../src/notify/index.js';
import { Store } from '../../src/store/index.js';
import { createKeyService } from '../../src/security/index.js';
import { FakeClock } from '../../src/shared/clock.js';
import type { NetworkMode } from '../../src/shared/network.js';
import type { Rule } from '../../src/shared/types.js';
import { FakeNetwork, markPrice } from '../binance/fakeNetwork.js';
import { FakeFuturesApi, orderTradeUpdate } from '../binance/fakeFutures.js';
import { FAKE_API_KEY, FakeKeychain, jsonResponse, makeEd25519, restrictions } from '../security/helpers.js';

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const MIN = 60_000;

class FakeProcess implements ProcessLike {
  handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  on(event: string, h: (...a: unknown[]) => void) {
    (this.handlers.get(event) ?? this.handlers.set(event, new Set()).get(event)!).add(h);
  }
  off(event: string, h: (...a: unknown[]) => void) {
    this.handlers.get(event)?.delete(h);
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of [...(this.handlers.get(event) ?? [])]) h(...args);
  }
}

type Draft = Omit<Rule, 'id' | 'createdAt'>;
const fut = { market: 'futures' as const, source: 'manual' as const, enabled: true };
const liqBtc = (pct = 5): Draft => ({ ...fut, type: 'liq', symbol: 'BTCUSDT', condition: { type: 'liq', pct }, repeat: { kind: 'cooldown', ms: 5 * MIN } });
const fillBtc: Draft = { ...fut, type: 'fill', symbol: 'BTCUSDT', condition: { type: 'fill' }, repeat: { kind: 'each' } };
const spotFillAll: Draft = { market: 'spot', source: 'manual', enabled: true, type: 'fill', symbol: '*', condition: { type: 'fill' }, repeat: { kind: 'each' } };

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let runtimes: Runtime[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blert-fut-'));
});
afterEach(async () => {
  for (const r of runtimes) await r.stop().catch(() => {});
  runtimes = [];
  await rm(dir, { recursive: true, force: true });
});

async function setup(drafts: Draft[], opts: { network?: NetworkMode; stored?: boolean } = {}) {
  const store = new Store(dir);
  await store.addRules(drafts);
  await store.updateConfig((c) => {
    c.disclaimerAccepted = true;
  });
  const key = makeEd25519();
  const clock = new FakeClock(T0);
  const net = new FakeNetwork(); // 공개 스트림
  const api = new FakeFuturesApi(key.publicKey, FAKE_API_KEY); // 선물 계정
  api.positions = [{ symbol: 'BTCUSDT', positionAmt: '0.5', markPrice: '90000', liquidationPrice: '80000' }];
  const keychain = new FakeKeychain();
  if (opts.stored !== false) keychain.stored = { apiKey: FAKE_API_KEY, privateKeyPem: key.pem };
  const sapi: { last: Response } = { last: jsonResponse(restrictions()) };
  const sapiFetch = vi.fn(async () => sapi.last.clone());
  const keys = createKeyService({ keychain, fetchFn: sapiFetch as unknown as typeof fetch, clock, mode: opts.network });

  const out: string[] = [];
  const proc = new FakeProcess();
  const rt = new Runtime({
    dir,
    io: { out: (t) => void out.push(t), err: (t) => void out.push(t) },
    makeNotifier: (logger) => createNotifier({ out: (l) => out.push(l), soundEnabled: () => false, clock, logger, platform: 'linux', run: async () => {} }),
    clock,
    process: proc,
    timing: { startupTimeoutMs: 300, sleepCheckMs: 20, silenceMs: 60_000 },
    keys,
    network: opts.network,
    feedOptions: { wsFactory: net.factory, fetchFn: (async () => { throw new Error('unexpected fetch'); }) as unknown as typeof fetch, sleep: async () => {} },
    accountFeedOptions: { fetchFn: (async () => { throw new Error('unexpected spot account fetch'); }) as unknown as typeof fetch },
    futuresAccountFeedOptions: { wsFactory: api.factory, fetchFn: api.fetchFn, sleep: async () => {} },
  });
  runtimes.push(rt);
  const logText = async () => {
    const files = await readdir(join(dir, 'logs')).catch(() => []);
    return (await Promise.all(files.map((f) => readFile(join(dir, 'logs', f), 'utf8')))).join('\n');
  };
  const has = (needle: string) => out.some((l) => l.includes(needle));
  const futuresOpen = () => waitFor(() => has('futures-account 연결됨'));
  return { rt, store, key, clock, net, api, keychain, sapi, sapiFetch, out, proc, logText, has, futuresOpen };
}

describe('runtime 선물 계정 알림 전체 경로 (FR-ALERT-05, FR-ACC-03)', () => {
  it('AC-35 청산가 규칙: 포지션을 읽고 마크 가격 스트림이 청산가 5% 이내로 들어오면 알린다', async () => {
    const h = await setup([liqBtc(5)]);
    const done = h.rt.runForeground();
    await h.futuresOpen();
    h.net.push('btcusdt@markPrice', markPrice('BTCUSDT', 0.0001, T0 + 8 * 60 * MIN, '90000'));
    await sleep(50);
    expect(h.has('청산가까지')).toBe(false); // 거리 11.1%
    h.net.push('btcusdt@markPrice', markPrice('BTCUSDT', 0.0001, T0 + 8 * 60 * MIN, '83000'));
    await waitFor(() => h.has('BTC 선물 청산가까지 3.6%'));
    expect(h.has('롱 청산가 80,000 · 마크 83,000 USDT · 기준 5% 이내')).toBe(true);
    h.net.push('btcusdt@markPrice', markPrice('BTCUSDT', 0.0001, T0 + 8 * 60 * MIN, '82000'));
    await sleep(50);
    expect(h.out.filter((l) => l.includes('청산가까지')).length).toBe(1); // 쿨다운
    h.proc.emit('SIGINT');
    expect(await done).toBe(0);
  });

  it('AC-36 시작할 때 이미 청산가 5% 이내이면 포지션을 읽자마자 바로 알린다', async () => {
    const h = await setup([liqBtc(5)]);
    h.api.positions = [{ symbol: 'BTCUSDT', positionAmt: '-1', markPrice: '100000', liquidationPrice: '102000' }]; // 숏, 거리 2%
    const done = h.rt.runForeground();
    await waitFor(() => h.has('BTC 선물 청산가까지 2.0%'));
    expect(h.has('숏 청산가 102,000')).toBe(true);
    h.proc.emit('SIGINT');
    await done;
  });

  it('AC-37 포지션이 없으면 알리지 않는다', async () => {
    const h = await setup([liqBtc(5)]);
    h.api.positions = [];
    const done = h.rt.runForeground();
    await h.futuresOpen();
    h.net.push('btcusdt@markPrice', markPrice('BTCUSDT', 0.0001, T0 + 8 * 60 * MIN, '83000'));
    await sleep(80);
    expect(h.has('청산가까지')).toBe(false);
    h.proc.emit('SIGINT');
    await done;
  });

  it('AC-39 선물 체결이 "BTC 선물 매수 체결 — 0.01 BTC @ 83,000 USDT" 알림으로 나온다 (공개 연결 없이 시작)', async () => {
    const h = await setup([fillBtc]);
    const done = h.rt.runForeground();
    await h.futuresOpen();
    expect(h.net.sockets).toHaveLength(0); // 선물 체결만 있으면 공개 스트림을 쓰지 않는다
    expect(h.api.callsTo('/fapi/v3/positionRisk')).toHaveLength(0); // 청산가 규칙이 없으면 포지션을 조회하지 않는다
    h.api.event(orderTradeUpdate({ symbol: 'BTCUSDT', side: 'BUY', qty: '0.01', price: '83000', orderId: 9, tradeId: 31 }));
    await waitFor(() => h.has('BTC 선물 매수 체결 — 0.01 BTC @ 83,000 USDT'));
    h.proc.emit('SIGINT');
    await done;
  });

  it('감시 시작 알림 뒤에 선물 계정 연결을 시작하고, 규칙이 바뀌면 켜고 끈다', async () => {
    const h = await setup([spotFillAll]);
    const done = h.rt.runForeground();
    await waitFor(() => h.has('감시 시작'));
    expect(h.api.sockets).toHaveLength(0); // 선물 규칙이 없으면 선물 연결도 키 확인도 하지 않는다

    await h.store.addRules([liqBtc(5)]);
    h.rt.bus.emit({ type: 'rules.changed', ts: '', ruleIds: [2] });
    await h.futuresOpen();
    expect(h.api.sockets).toHaveLength(1);

    await h.store.deleteRules(2);
    h.rt.bus.emit({ type: 'rules.changed', ts: '', ruleIds: [2] });
    await waitFor(() => h.api.sockets[0]!.closed);
    h.proc.emit('SIGINT');
    await done;
  });

  it('절전에서 깨면 선물 계정 연결도 다시 맺고 포지션을 다시 읽는다', async () => {
    const h = await setup([liqBtc(5)]);
    const done = h.rt.runForeground();
    await h.futuresOpen();
    const reads = h.api.callsTo('/fapi/v3/positionRisk').length;
    h.clock.advance(90_000);
    await waitFor(() => h.api.sockets.length === 2);
    await waitFor(() => h.api.callsTo('/fapi/v3/positionRisk').length > reads);
    expect(h.api.sockets[0]!.closed).toBe(true);
    h.proc.emit('SIGINT');
    await done;
  });

  it('종료하면 선물 계정 연결도 닫고 다시 시도하지 않는다', async () => {
    const h = await setup([liqBtc(5)]);
    const done = h.rt.runForeground();
    await h.futuresOpen();
    h.proc.emit('SIGINT');
    await done;
    expect(h.api.sockets.every((s) => s.closed)).toBe(true);
    const n = h.api.sockets.length;
    await sleep(1300);
    expect(h.api.sockets).toHaveLength(n);
  });
});

describe('runtime 선물 키 문제 (AC-38, FR-KEY-02, FR-KEY-04, D-53)', () => {
  it('AC-38 선물 권한(enableFutures)이 켜진 키면 선물 연결을 만들지 않고 알린다. 공개 알림은 유지한다', async () => {
    const h = await setup([liqBtc(5)]);
    h.sapi.last = jsonResponse(restrictions({ enableFutures: true }));
    const done = h.rt.runForeground();
    await waitFor(() => h.has('계정 알림 중단 — 거래 권한이 켜진 키'));
    expect(h.has('enableFutures')).toBe(true);
    expect(h.api.sockets).toHaveLength(0);
    expect(h.api.fetch).not.toHaveBeenCalled(); // listenKey도 발급받지 않는다
    // 공개 알림(마크 가격 스트림)은 계속 동작한다
    expect(h.net.live.length).toBeGreaterThan(0);
    h.proc.emit('SIGINT');
    expect(await done).toBe(0);
  });

  it('현물·선물 계정 규칙이 함께 있어도 키 문제는 한 번만 알린다', async () => {
    const h = await setup([spotFillAll, fillBtc]);
    h.sapi.last = jsonResponse(restrictions({ enableFutures: true }));
    const done = h.rt.runForeground();
    await waitFor(() => h.has('계정 알림 중단 — 거래 권한이 켜진 키'));
    await sleep(200);
    expect(h.out.filter((l) => l.includes('거래 권한이 켜진 키'))).toHaveLength(1);
    h.proc.emit('SIGINT');
    await done;
  });

  it('키가 없으면 선물 계정 알림 수까지 포함해 한 번 알린다', async () => {
    const h = await setup([liqBtc(5), fillBtc], { stored: false });
    const done = h.rt.runForeground();
    await waitFor(() => h.has('계정 알림 2개를 감시하지 못합니다'));
    expect(h.out.filter((l) => l.includes('계정 알림 2개'))).toHaveLength(1);
    h.proc.emit('SIGINT');
    await done;
  });

  it('listenKey 발급이 키 거부로 돌아오면 계정 알림 중단을 알린다', async () => {
    const h = await setup([liqBtc(5)]);
    h.api.queue.push(new Response(JSON.stringify({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action' }), { status: 401 }));
    const done = h.rt.runForeground();
    await waitFor(() => h.has('계정 알림 중단 — 키를 쓸 수 없음'));
    expect(h.api.sockets).toHaveLength(0);
    h.proc.emit('SIGINT');
    await done;
  });
});

describe('runtime 선물 테스트넷 모드와 키 흔적 (D-48, NFR-SEC-01)', () => {
  it('AC-41 테스트넷 모드에서는 선물 데모 주소를 쓰고 권한 조회(/sapi)를 하지 않는다', async () => {
    const h = await setup([fillBtc], { network: 'testnet' });
    const done = h.rt.runForeground();
    await h.futuresOpen();
    expect(h.out[0]).toContain('[테스트넷 모드]');
    expect(h.api.callsTo('/fapi/v1/listenKey', 'POST')[0]!.origin).toBe('https://demo-fapi.binance.com');
    expect(h.api.sockets[0]!.url.startsWith('wss://demo-fstream.binance.com/private/ws?listenKey=')).toBe(true);
    expect(h.sapiFetch).not.toHaveBeenCalled();
    h.proc.emit('SIGINT');
    await done;
  });

  it('AC-41 실서버 모드에서는 실서버 선물 주소를 쓴다', async () => {
    const h = await setup([fillBtc]);
    const done = h.rt.runForeground();
    await h.futuresOpen();
    expect(h.api.callsTo('/fapi/v1/listenKey', 'POST')[0]!.origin).toBe('https://fapi.binance.com');
    expect(h.api.sockets[0]!.url.startsWith('wss://fstream.binance.com/private/ws?listenKey=')).toBe(true);
    h.proc.emit('SIGINT');
    await done;
  });

  it('NFR-SEC-01 실행이 끝난 뒤에도 화면·로그에 API 키와 listenKey가 없다', async () => {
    const h = await setup([liqBtc(5), fillBtc]);
    const done = h.rt.runForeground();
    await h.futuresOpen();
    h.api.event(orderTradeUpdate({ symbol: 'BTCUSDT', side: 'SELL', qty: 1, price: 83_000, orderId: 1, tradeId: 1 }));
    await waitFor(() => h.has('선물 매도 체결'));
    h.proc.emit('SIGINT');
    await done;
    const text = `${h.out.join('\n')}\n${await h.logText()}`;
    expect(text).not.toContain(FAKE_API_KEY);
    expect(text).not.toMatch(/LK-\d/);
    expect(text).not.toContain('PRIVATE KEY');
  });
});
