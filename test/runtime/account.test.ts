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
import { FakeNetwork, miniTicker } from '../binance/fakeNetwork.js';
import { FakeAccountRest, FakeApiServer, accountPosition, executionReport } from '../binance/fakeApi.js';
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
const base = { market: 'spot' as const, source: 'manual' as const, enabled: true };
const fillAll: Draft = { ...base, type: 'fill', symbol: '*', condition: { type: 'fill' }, repeat: { kind: 'each' } };
const balanceUsdt: Draft = { ...base, type: 'balance', symbol: '*', condition: { type: 'balance', asset: 'USDT', pct: 5 }, repeat: { kind: 'cooldown', ms: 10 * MIN } };
const priceBtc: Draft = { ...base, type: 'price', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 70000 }, repeat: { kind: 'once' } };

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
  dir = await mkdtemp(join(tmpdir(), 'blert-acct-'));
});
afterEach(async () => {
  for (const r of runtimes) await r.stop().catch(() => {});
  runtimes = [];
  await rm(dir, { recursive: true, force: true });
});

interface Opts {
  stored?: boolean;
  keychain?: boolean;
  network?: NetworkMode;
}

async function setup(drafts: Draft[], opts: Opts = {}) {
  const store = new Store(dir);
  await store.addRules(drafts);
  await store.updateConfig((c) => {
    c.disclaimerAccepted = true;
  });
  const key = makeEd25519();
  const clock = new FakeClock(T0);
  const net = new FakeNetwork(); // 공개 스트림
  const api = new FakeApiServer(key.publicKey, FAKE_API_KEY); // 계정 WebSocket API
  const rest = new FakeAccountRest(key.publicKey, FAKE_API_KEY); // 계정 REST
  rest.balances = [{ asset: 'USDT', free: 1000, locked: 0 }, { asset: 'BTC', free: 0.5, locked: 0 }];
  const keychain = new FakeKeychain();
  keychain.isAvailable = opts.keychain ?? true;
  if (opts.stored !== false) keychain.stored = { apiKey: FAKE_API_KEY, privateKeyPem: key.pem };

  /** 권한 조회(/sapi) 응답. Response 또는 Error를 바꿔 끼운다 */
  const sapi: { next: (Response | Error)[]; last: Response | Error } = { next: [], last: jsonResponse(restrictions()) };
  const sapiFetch = vi.fn(async () => {
    const r = sapi.next.shift() ?? sapi.last;
    if (r instanceof Error) throw r;
    return r.clone();
  });
  const keys = createKeyService({ keychain, fetchFn: sapiFetch as unknown as typeof fetch, clock, mode: opts.network });

  const out: string[] = [];
  const err: string[] = [];
  const proc = new FakeProcess();
  const rt = new Runtime({
    dir,
    io: { out: (t) => void out.push(t), err: (t) => void err.push(t) },
    makeNotifier: (logger) =>
      createNotifier({ out: (l) => out.push(l), soundEnabled: () => false, clock, logger, platform: 'linux', run: async () => {} }),
    clock,
    process: proc,
    timing: { startupTimeoutMs: 300, sleepCheckMs: 20, silenceMs: 60_000 },
    keys,
    network: opts.network,
    feedOptions: { wsFactory: net.factory, fetchFn: (async () => { throw new Error('unexpected fetch'); }) as unknown as typeof fetch, sleep: async () => {} },
    accountFeedOptions: { wsFactory: api.factory, fetchFn: rest.fetchFn, sleep: async () => {} },
  });
  runtimes.push(rt);
  const logText = async () => {
    const files = await readdir(join(dir, 'logs')).catch(() => []);
    return (await Promise.all(files.map((f) => readFile(join(dir, 'logs', f), 'utf8')))).join('\n');
  };
  const has = (needle: string) => out.some((l) => l.includes(needle));
  const started = () => waitFor(() => has('감시 시작'));
  const accountOpen = () => waitFor(() => has('account 연결됨'));
  return { rt, store, key, clock, net, api, rest, keychain, sapi, sapiFetch, out, err, proc, logText, has, started, accountOpen };
}

describe('runtime 계정 알림 전체 경로 (FR-ACC-01~02, FR-KEY-03)', () => {
  it('AC-29 허용 IP 제한이 없는 읽기 전용 키는 경고한 뒤 정상 실행한다', async () => {
    const h = await setup([fillAll]);
    h.sapi.last = jsonResponse(restrictions({ ipRestrict: false }));
    const done = h.rt.runForeground();
    await h.accountOpen();
    expect(h.has('허용 IP 제한이 없는 키')).toBe(true);
    expect(h.has('바이낸스 API 관리에서 허용 IP를 설정하세요')).toBe(true);
    expect(h.api.logons[0]).toMatchObject({ valid: true });
    h.proc.emit('SIGINT');
    expect(await done).toBe(0);
  });

  it('IP 제한이 있는 키는 경고하지 않는다', async () => {
    const h = await setup([fillAll]);
    const done = h.rt.runForeground();
    await h.accountOpen();
    expect(h.has('허용 IP 제한이 없는 키')).toBe(false);
    h.proc.emit('SIGINT');
    await done;
  });

  it('AC-31 체결 이벤트가 "BTC 매수 체결 — 0.015 BTC @ 68,420 USDT" 알림으로 나온다', async () => {
    const h = await setup([fillAll]);
    const done = h.rt.runForeground();
    await h.accountOpen();
    h.api.event(executionReport({ symbol: 'BTCUSDT', side: 'BUY', qty: '0.01500000', price: '68420.00000000', orderId: 1, tradeId: 1 }));
    await waitFor(() => h.has('BTC 매수 체결 — 0.015 BTC @ 68,420 USDT'));
    h.api.event(executionReport({ symbol: 'ETHUSDT', side: 'SELL', qty: 2, price: 3412.5, orderId: 2, tradeId: 2 }));
    await waitFor(() => h.has('ETH 매도 체결 — 2 ETH @ 3,412.5 USDT'));
    h.proc.emit('SIGINT');
    await done;
  });

  it('AC-32 시작 잔고를 기준으로 6% 감소는 알리고, 5분 뒤 또 6% 감소는 쿨다운 때문에 알리지 않는다', async () => {
    const h = await setup([balanceUsdt]);
    const done = h.rt.runForeground();
    await h.accountOpen();
    await waitFor(() => h.rest.accountCalls() > 0); // 시작 잔고 스냅샷
    await sleep(50);

    h.api.event(accountPosition([{ asset: 'USDT', free: 940 }]));
    await waitFor(() => h.has('USDT 잔고 −6.0% — 1,000 → 940 USDT'));

    h.clock.advance(5 * MIN);
    h.api.event(accountPosition([{ asset: 'USDT', free: 884 }])); // 940 대비 −5.96%지만 쿨다운(10분) 중
    await sleep(100);
    expect(h.out.filter((l) => l.includes('USDT 잔고')).length).toBe(1);
    h.proc.emit('SIGINT');
    await done;
  });

  it('계정 규칙만 있으면 공개 연결을 기다리지 않고 시작한다', async () => {
    const h = await setup([fillAll]);
    const done = h.rt.runForeground();
    await h.accountOpen();
    expect(h.net.sockets).toHaveLength(0);
    expect(h.has('spot 연결됨')).toBe(false);
    expect(h.has('규칙 1개 · 현물 1 · 선물 0')).toBe(true);
    h.proc.emit('SIGINT');
    await done;
  });

  it('감시 시작 알림 뒤에 계정 연결을 시작한다 (B9 시작 순서)', async () => {
    const h = await setup([fillAll]);
    const done = h.rt.runForeground();
    await h.accountOpen();
    expect(h.out.findIndex((l) => l.includes('감시 시작'))).toBeLessThan(h.out.findIndex((l) => l.includes('account 연결됨')));
    h.proc.emit('SIGINT');
    await done;
  });
});

describe('runtime 키 문제와 공개 알림의 독립 (FR-KEY-02, FR-KEY-04, D-30)', () => {
  it('AC-30 재연결 때 권한이 거래 권한으로 바뀌면 계정 기능만 멈추고, warn 알림을 내며, 공개 알림은 유지한다', async () => {
    const h = await setup([fillAll, priceBtc]);
    const done = h.rt.runForeground();
    await h.accountOpen();
    h.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 69_000)); // 공개 알림의 기준(70,000 아래)

    h.sapi.last = jsonResponse(restrictions({ enableSpotAndMarginTrading: true })); // 그 사이 거래 권한이 켜졌다
    const sockets = h.api.sockets.length;
    h.api.dropAll(); // 계정 연결이 끊김 → 1초 뒤 재연결 시도 → 권한 재검사
    await waitFor(() => h.has('계정 알림 중단 — 거래 권한이 켜진 키'), 6000);
    expect(h.has('enableSpotAndMarginTrading')).toBe(true);
    expect(h.has('공개 알림은 계속됩니다')).toBe(true);
    expect(h.api.sockets).toHaveLength(sockets); // 새 계정 연결을 만들지 않았다
    await sleep(1500);
    expect(h.api.sockets).toHaveLength(sockets); // 다시 시도하지 않는다
    expect(h.out.filter((l) => l.includes('거래 권한이 켜진 키'))).toHaveLength(1);

    // 공개 알림은 그대로 동작한다
    h.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 70_010));
    await waitFor(() => h.has('BTC 70,000 돌파'));
    h.proc.emit('SIGINT');
    expect(await done).toBe(0);
  });

  it('시작할 때 출금 권한이 켜진 키면 계정 연결 없이 공개 알림만 시작한다', async () => {
    const h = await setup([fillAll, priceBtc]);
    h.sapi.last = jsonResponse(restrictions({ enableWithdrawals: true }));
    const done = h.rt.runForeground();
    await waitFor(() => h.has('계정 알림 중단 — 출금 권한이 켜진 키'));
    expect(h.has('enableWithdrawals')).toBe(true);
    expect(h.api.sockets).toHaveLength(0);
    h.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 69_000));
    h.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 70_010));
    await waitFor(() => h.has('BTC 70,000 돌파'));
    h.proc.emit('SIGINT');
    await done;
  });

  it('AC-34 키체인이 없는 환경에서는 계정 알림 중단을 안내하고 공개 알림은 정상 동작한다', async () => {
    const h = await setup([fillAll, priceBtc], { keychain: false });
    const done = h.rt.runForeground();
    await waitFor(() => h.has('계정 알림 중단 — OS 키체인 없음'));
    expect(h.api.sockets).toHaveLength(0);
    h.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 69_000));
    h.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 70_010));
    await waitFor(() => h.has('BTC 70,000 돌파'));
    h.proc.emit('SIGINT');
    expect(await done).toBe(0);
  });

  it('키가 없으면 감시하지 못하는 계정 알림 수와 등록 방법을 알린다', async () => {
    const h = await setup([fillAll, balanceUsdt, priceBtc], { stored: false });
    const done = h.rt.runForeground();
    await waitFor(() => h.has('계정 알림 2개를 감시하지 못합니다'));
    expect(h.has('API 키가 없습니다')).toBe(true);
    expect(h.api.sockets).toHaveLength(0);
    h.proc.emit('SIGINT');
    await done;
  });

  it('바이낸스가 키를 거부하면(-2015) 원인을 알리고 계정 기능만 멈춘다', async () => {
    const h = await setup([fillAll]);
    h.sapi.last = jsonResponse({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }, 401);
    const done = h.rt.runForeground();
    await waitFor(() => h.has('계정 알림 중단 — 키를 쓸 수 없음'));
    expect(h.has('-2015')).toBe(true);
    expect(h.api.sockets).toHaveLength(0);
    h.proc.emit('SIGINT');
    await done;
  });

  it('로그인(session.logon)이 거부되면 사용자에게 알리고 계정 기능만 멈춘다', async () => {
    const h = await setup([fillAll, priceBtc]);
    h.api.logonResult = { status: 401, code: -2015 };
    const done = h.rt.runForeground();
    await waitFor(() => h.has('계정 알림 중단 — 키를 쓸 수 없음')); // 로그에만 남기지 않고 화면·알림으로 알린다
    expect(h.has('logon rejected')).toBe(true);
    expect(h.out.filter((l) => l.includes('계정 알림 중단')).length).toBe(1);
    expect(await h.logText()).toContain('account features stopped');
    h.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 69_000));
    h.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 70_010));
    await waitFor(() => h.has('BTC 70,000 돌파')); // 공개 알림은 유지
    h.proc.emit('SIGINT');
    await done;
  });

  it('로그인 직후 연결이 반복해서 끊기면(쓸 수 없는 키) 알리고 멈춘다. 공개 알림은 유지한다', async () => {
    const h = await setup([fillAll, priceBtc], { network: 'testnet' }); // 테스트넷은 /sapi 검사가 없어 이 경로가 실제로 쓰인다
    h.api.dropOnLogon = true;
    const done = h.rt.runForeground();
    await waitFor(() => h.has('계정 알림 중단 — 키를 쓸 수 없음'), 8000);
    expect(h.has('dropped during session.logon 3 times')).toBe(true);
    expect(h.api.sockets).toHaveLength(3);
    h.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 69_000));
    h.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 70_010));
    await waitFor(() => h.has('BTC 70,000 돌파'));
    h.proc.emit('SIGINT');
    await done;
  });

  it('권한을 일시적으로 확인하지 못하면(네트워크) 연결을 만들지 않고 다시 확인한다', async () => {
    const h = await setup([fillAll]);
    h.sapi.next = [new TypeError('fetch failed')];
    const done = h.rt.runForeground();
    await h.started();
    await sleep(200);
    expect(h.api.sockets).toHaveLength(0);
    expect(h.has('계정 알림 중단')).toBe(false); // 일시적 실패는 중단이 아니다
    await h.accountOpen(); // 1초 뒤 다시 확인해 연결
    expect(h.api.sockets).toHaveLength(1);
    h.proc.emit('SIGINT');
    await done;
  });
});

describe('runtime 계정 연결 수명 (FR-RUN-02, FR-CONN-02)', () => {
  it('규칙이 바뀌면 계정 연결을 켜고 끈다', async () => {
    const h = await setup([priceBtc]);
    const done = h.rt.runForeground();
    await h.started();
    expect(h.api.sockets).toHaveLength(0); // 계정 규칙이 없으면 키를 확인하지도 않는다
    expect(h.sapiFetch).not.toHaveBeenCalled();

    await h.store.addRules([fillAll]);
    h.rt.bus.emit({ type: 'rules.changed', ts: '', ruleIds: [2] });
    await h.accountOpen();
    expect(h.api.sockets).toHaveLength(1);

    await h.store.deleteRules(2);
    h.rt.bus.emit({ type: 'rules.changed', ts: '', ruleIds: [2] });
    await waitFor(() => h.api.sockets[0]!.closed);
    h.proc.emit('SIGINT');
    await done;
  });

  it('절전에서 깨면 계정 연결도 다시 맺는다', async () => {
    const h = await setup([fillAll]);
    const done = h.rt.runForeground();
    await h.accountOpen();
    h.clock.advance(90_000);
    await waitFor(() => h.api.sockets.length === 2);
    expect(h.api.sockets[0]!.closed).toBe(true);
    await waitFor(() => h.api.live.length === 1);
    h.proc.emit('SIGINT');
    await done;
  });

  it('종료하면 계정 연결도 닫고 다시 시도하지 않는다', async () => {
    const h = await setup([fillAll]);
    const done = h.rt.runForeground();
    await h.accountOpen();
    h.proc.emit('SIGINT');
    await done;
    expect(h.api.sockets.every((s) => s.closed)).toBe(true);
    const n = h.api.sockets.length;
    await sleep(1300);
    expect(h.api.sockets).toHaveLength(n);
  });
});

describe('runtime 테스트넷 모드 (결정 1A, 개발자 전용)', () => {
  it('배너를 보이고 테스트넷 주소를 쓰며 권한 조회(/sapi)를 하지 않는다', async () => {
    const h = await setup([fillAll], { network: 'testnet' });
    const done = h.rt.runForeground();
    await h.accountOpen();
    expect(h.out[0]).toContain('[테스트넷 모드]');
    expect(h.api.sockets[0]!.url).toBe('wss://ws-api.testnet.binance.vision/ws-api/v3');
    expect(h.sapiFetch).not.toHaveBeenCalled();
    h.proc.emit('SIGINT');
    await done;
  });

  it('실서버 모드에서는 배너가 없고 실서버 주소와 권한 조회를 쓴다', async () => {
    const h = await setup([fillAll]);
    const done = h.rt.runForeground();
    await h.accountOpen();
    expect(h.out.join('\n')).not.toContain('테스트넷');
    expect(h.api.sockets[0]!.url).toBe('wss://ws-api.binance.com:443/ws-api/v3');
    expect(h.sapiFetch).toHaveBeenCalledTimes(1);
    h.proc.emit('SIGINT');
    await done;
  });
});

describe('runtime 키 흔적 (NFR-SEC-01)', () => {
  it('실행 전체(체결·잔고·권한 거부)가 끝난 뒤에도 설정 폴더·로그·화면 어디에도 키가 없다', async () => {
    const h = await setup([fillAll, balanceUsdt]);
    const done = h.rt.runForeground();
    await h.accountOpen();
    h.api.event(executionReport({ symbol: 'BTCUSDT', side: 'BUY', qty: 1, price: 70_000, orderId: 1, tradeId: 1 }));
    h.api.event(accountPosition([{ asset: 'USDT', free: 900 }]));
    await waitFor(() => h.has('체결'));
    h.sapi.last = jsonResponse(restrictions({ enableWithdrawals: true }));
    h.api.dropAll();
    await waitFor(() => h.has('출금 권한이 켜진 키'), 6000);
    h.proc.emit('SIGINT');
    await done;

    const files: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (e.isFile()) files.push(await readFile(join(e.parentPath, e.name), 'utf8'));
    }
    const dump = files.join('\n') + h.out.join('\n') + h.err.join('\n');
    const secrets = [FAKE_API_KEY, h.key.pem.split('\n')[1]!, String(h.api.logons[0]!.signature)];
    for (const s of secrets) expect(dump).not.toContain(s);
    expect(files.length).toBeGreaterThan(2); // 설정·규칙·상태·로그가 실제로 스캔되었다
  });
});
