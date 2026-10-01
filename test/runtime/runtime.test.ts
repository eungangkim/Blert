import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, type ProcessLike, type RuntimeOptions } from '../../src/runtime/index.js';
import { createNotifier } from '../../src/notify/index.js';
import { clockHM } from '../../src/notify/render.js';
import { Store } from '../../src/store/index.js';
import { writePidFile } from '../../src/store/pid.js';
import { FakeClock, iso } from '../../src/shared/clock.js';
import { BlertError } from '../../src/shared/errors.js';
import type { Rule } from '../../src/shared/types.js';
import { FakeNetwork, miniTicker } from '../binance/fakeNetwork.js';

const T0 = Date.UTC(2026, 9, 3, 5, 0, 0);
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
  get size() {
    return [...this.handlers.values()].reduce((n, s) => n + s.size, 0);
  }
}

type Draft = Omit<Rule, 'id' | 'createdAt'>;
const price = (symbol: string, target: number, repeat: Draft['repeat'] = { kind: 'once' }, market: Draft['market'] = 'spot'): Draft => ({
  type: 'price', market, symbol, condition: { type: 'price', direction: 'above', price: target }, repeat, source: 'manual', enabled: true,
});
const funding: Draft = {
  type: 'funding', market: 'futures', symbol: 'BTCUSDT', condition: { type: 'funding', direction: 'above', pct: 0.05 },
  repeat: { kind: 'hysteresis', widthPct: 20 }, source: 'manual', enabled: true,
};

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
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
  dir = await mkdtemp(join(tmpdir(), 'blert-runtime-'));
});
afterEach(async () => {
  for (const r of runtimes) await r.stop().catch(() => {});
  runtimes = [];
  await rm(dir, { recursive: true, force: true });
});

async function setup(drafts: Draft[], extra: Partial<RuntimeOptions> = {}, fetchFn?: typeof fetch) {
  const store = new Store(dir);
  if (drafts.length) await store.addRules(drafts);
  await store.updateConfig((c) => {
    c.disclaimerAccepted = true; // init을 마친 상태
  });
  const net = new FakeNetwork();
  const clock = new FakeClock(T0);
  const out: string[] = [];
  const err: string[] = [];
  const proc = new FakeProcess();
  const toasts: string[] = [];
  const rt = new Runtime({
    dir,
    io: { out: (t) => void out.push(t), err: (t) => void err.push(t) },
    makeNotifier: (logger) =>
      createNotifier({
        out: (l) => out.push(l),
        soundEnabled: () => false,
        clock,
        logger,
        platform: 'linux',
        run: async (cmd, args) => void toasts.push(`${cmd} ${args.join(' ')}`),
      }),
    clock,
    process: proc,
    timing: { startupTimeoutMs: 300, sleepCheckMs: 20, silenceMs: 200, ...extra.timing },
    feedOptions: {
      wsFactory: net.factory,
      fetchFn: fetchFn ?? ((async () => { throw new Error('unexpected fetch'); }) as unknown as typeof fetch),
      sleep: async () => {},
    },
    ...extra,
  });
  runtimes.push(rt);
  const logText = async () => {
    const files = await readdir(join(dir, 'logs')).catch(() => []);
    return (await Promise.all(files.map((f) => readFile(join(dir, 'logs', f), 'utf8')))).join('\n');
  };
  const started = (needle = '감시 시작') => waitFor(() => out.some((l) => l.includes(needle)));
  return { rt, store, net, clock, out, err, proc, toasts, logText, started };
}

describe('runtime 시작·종료 (FR-RUN-01, B9)', () => {
  it('AC-20 run은 감시 시작 알림을 내고, Ctrl+C로 상태를 저장한 뒤 종료 코드 0으로 끝난다', async () => {
    const { rt, store, net, out, proc, logText, started } = await setup([price('BTCUSDT', 70000), funding]);
    const done = rt.runForeground();
    await started();
    expect(out.join('\n')).toContain('규칙 2개 · 현물 1 · 선물 1');
    expect(out.join('\n')).toContain('감시 중입니다. 종료하려면 Ctrl+C');
    expect(net.sockets.map((s) => new URL(s.url).host).sort()).toEqual(['fstream.binance.com', 'stream.binance.com:9443']);

    expect((await store.readRunLock())?.pid).toBe(process.pid); // 실행 중에는 잠금 파일이 있다
    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 69_000)); // 기준(70,000) 아래에서 시작
    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 70_010)); // 넘는 순간: 1회성 규칙 발동
    await waitFor(() => out.some((l) => l.includes('BTC 70,000 돌파')));

    proc.emit('SIGINT');
    expect(await done).toBe(0);

    // 종료 시 상태 저장: 1회성 규칙은 삭제하지 않고 비활성으로, 발동 시각은 state.json에
    const rules = await store.loadRules();
    expect(rules.find((r) => r.symbol === 'BTCUSDT')?.enabled).toBe(false);
    expect((await store.loadStates()).find((s) => s.ruleId === 1)?.lastFiredAt).toBeDefined();
    expect(out.join('\n')).toContain('감시를 종료했습니다');
    expect(net.sockets.every((s) => s.closed)).toBe(true); // 연결 종료
    expect(proc.size).toBe(0); // 신호 처리기 정리
    expect(await store.readRunLock()).toBeUndefined(); // 정상 종료하면 PID 파일 삭제 (B9)
    const log = await logText();
    expect(log).toContain('starting with 2 rules');
    expect(log).toContain('stopped (exit 0)');
    expect(log).toContain('BTC 70,000 돌파'); // 발동한 알림 전체를 로그에도 남긴다 (B7)
  });

  it('Ctrl+C를 여러 번 눌러도 한 번만 종료 처리한다', async () => {
    const { rt, out, proc, started } = await setup([price('BTCUSDT', 70000)]);
    const done = rt.runForeground();
    await started();
    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    expect(await done).toBe(0);
    expect(out.filter((l) => l.includes('감시를 종료했습니다'))).toHaveLength(1);
  });

  it('SIGTERM으로도 종료한다', async () => {
    const { rt, proc, started } = await setup([price('BTCUSDT', 70000)]);
    const done = rt.runForeground();
    await started();
    proc.emit('SIGTERM');
    expect(await done).toBe(0);
  });

  it('활성 알림이 하나도 없으면 시작하지 않고 추가 방법을 안내한다 (종료 코드 1)', async () => {
    const none = await setup([]);
    await expect(none.rt.runForeground()).rejects.toMatchObject({ messageKey: 'err.runNoRules', exitCode: 1 });
    expect(none.net.sockets).toHaveLength(0);

    const paused = await setup([price('BTCUSDT', 70000)]);
    await paused.store.setEnabled('all', false);
    await expect(paused.rt.runForeground()).rejects.toBeInstanceOf(BlertError);
  });

  it('시작할 때 연결할 수 없으면 종료 코드 3과 확인할 것을 안내하고 재시도를 멈춘다', async () => {
    const { rt, net, out, err } = await setup([price('BTCUSDT', 70000)]);
    net.refuse = true;
    expect(await rt.runForeground()).toBe(3);
    expect(err[0]).toContain('바이낸스에 연결하지 못했습니다(spot)');
    expect(err[0]).toContain('예:');
    expect(out.join('\n')).not.toContain('감시 중입니다');
    const n = net.sockets.length;
    await sleep(1300); // 예약된 재시도가 남아 있지 않아야 한다
    expect(net.sockets).toHaveLength(n);
  });

  it('감시 시작 알림에는 시작한 시각의 활성 규칙 수를 적는다 (일시정지 제외)', async () => {
    const { rt, store, out, proc, started } = await setup([price('BTCUSDT', 70000), price('ETHUSDT', 3000), price('SOLUSDT', 100)]);
    await store.setEnabled(3, false);
    const done = rt.runForeground();
    await started();
    expect(out.join('\n')).toContain('규칙 2개 · 현물 2 · 선물 0');
    proc.emit('SIGINT');
    await done;
  });
});

describe('runtime 절전 복귀 (FR-RUN-02, NFR-REL-02)', () => {
  it('AC-21 시계가 90초 건너뛰면 다시 연결하고 중단 구간을 warn 알림과 로그로 남긴다', async () => {
    const { rt, net, clock, out, proc, started, logText } = await setup([price('BTCUSDT', 70000)]);
    const done = rt.runForeground();
    await started();
    expect(net.sockets).toHaveLength(1);

    clock.advance(90_000); // 노트북 덮개를 닫았다 연 것처럼
    await waitFor(() => out.some((l) => l.includes('감시 중단 구간 있음')));
    const line = out.find((l) => l.includes('감시 중단 구간 있음'))!;
    expect(line).toContain(`${clockHM(T0)} ~ ${clockHM(T0 + 90_000)} 동안 감시하지 못함`);
    expect(line).toContain('!'); // warn 표시

    await waitFor(() => net.sockets.length === 2 && net.live.length === 1); // 모든 연결을 다시 맺음
    expect(net.sockets[0]!.closed).toBe(true);
    expect([...net.live[0]!.subscribed]).toEqual(['btcusdt@miniTicker']);
    const log = await logText();
    expect(log).toContain('system wake detected');
    expect(log).toMatch(/monitoring gap \(sleep\)/);

    proc.emit('SIGINT');
    await done;
  });

  it('60초 미만의 시계 변화는 절전으로 보지 않는다', async () => {
    const { rt, net, clock, out, proc, started } = await setup([price('BTCUSDT', 70000)]);
    const done = rt.runForeground();
    await started();
    clock.advance(59_000);
    await sleep(120);
    expect(out.join('\n')).not.toContain('감시 중단 구간');
    expect(net.sockets).toHaveLength(1);
    proc.emit('SIGINT');
    await done;
  });

  it('절전에서 깨면 끊긴 사이의 1분봉을 REST로 다시 채운다', async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    const change: Draft = { type: 'change', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'change', pct: 5, windowMs: 60 * MIN, direction: 'both' }, repeat: { kind: 'cooldown', ms: 30 * MIN }, source: 'manual', enabled: true };
    const { rt, clock, proc, started } = await setup([change], {}, fetchFn);
    const done = rt.runForeground();
    await started();
    await waitFor(() => calls.length === 1);
    clock.advance(90_000);
    await waitFor(() => calls.length === 2);
    proc.emit('SIGINT');
    await done;
  });
});

describe('runtime 콘솔 안내 (B5)', () => {
  it('연결이 끊기면 재시도 시각을 콘솔에 표시한다', async () => {
    const { rt, net, out, proc, started } = await setup([price('BTCUSDT', 70000)]);
    const done = rt.runForeground();
    await started();
    net.refuse = true;
    net.dropAll();
    await waitFor(() => out.some((l) => l.includes('연결이 끊겼습니다')));
    expect(out.find((l) => l.includes('연결이 끊겼습니다'))).toBe('spot 연결이 끊겼습니다. 1초 뒤 다시 연결합니다 (1번째 시도)');
    proc.emit('SIGINT');
    await done;
  });

  it('시작 뒤에도 데이터가 오지 않거나 바이낸스가 거절한 심볼을 한 번 안내한다', async () => {
    const fetchFn = (async () => new Response('{"code":-1121,"msg":"Invalid symbol."}', { status: 400 })) as unknown as typeof fetch;
    const change: Draft = { type: 'change', market: 'spot', symbol: 'QQQUSDT', condition: { type: 'change', pct: 5, windowMs: 60 * MIN, direction: 'both' }, repeat: { kind: 'cooldown', ms: 30 * MIN }, source: 'manual', enabled: true };
    const { rt, net, out, proc, started } = await setup([price('BTCUSDT', 70000), price('ZZZUSDT', 1), change], { timing: { silenceMs: 150 } }, fetchFn);
    const done = rt.runForeground();
    await started();
    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 1)); // BTC만 데이터가 온다
    await waitFor(() => out.some((l) => l.includes('데이터가 오지 않습니다')));
    const line = out.find((l) => l.includes('데이터가 오지 않습니다'))!;
    expect(line).toContain('현물 ZZZUSDT');
    expect(line).toContain('현물 QQQUSDT');
    expect(line).not.toContain('BTCUSDT');
    expect(line).toContain('예:');
    proc.emit('SIGINT');
    await done;
  });
});

describe('runtime 규칙 변경 반영', () => {
  it('1회성 규칙이 발동해 꺼지면 더 이상 필요 없는 스트림 구독을 해제한다', async () => {
    const { rt, net, proc, started, out } = await setup([price('BTCUSDT', 70000), price('ETHUSDT', 3000)]);
    const done = rt.runForeground();
    await started();
    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 69_000));
    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 70_010));
    await waitFor(() => out.some((l) => l.includes('BTC 70,000 돌파')));
    await waitFor(() => net.sockets[0]!.sent.some((m) => m.method === 'UNSUBSCRIBE'), 3000);
    expect(net.sockets[0]!.sent.find((m) => m.method === 'UNSUBSCRIBE')!.params).toEqual(['btcusdt@miniTicker']);
    expect([...net.sockets[0]!.subscribed]).toEqual(['ethusdt@miniTicker']);
    proc.emit('SIGINT');
    await done;
  });
});

describe('runtime 내부 오류 (B10)', () => {
  const throwing = (rt: Runtime) => rt.bus.on('market.ticker', () => { throw new Error('boom'); });
  const ready = (net: FakeNetwork, n: number) => waitFor(() => net.sockets.length === n && net.live[0]?.subscribed.has('btcusdt@miniTicker') === true);

  it('예상 못한 예외는 로그를 남기고 감시 코어를 다시 시작하며, 3회 연속이면 종료 코드 9로 끝낸다', async () => {
    const { rt, net, err, started, logText } = await setup([price('BTCUSDT', 1e9)], { timing: { healthyMs: 60_000, startupTimeoutMs: 300 } });
    const done = rt.runForeground();
    await started();
    throwing(rt);

    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 1));
    await ready(net, 2); // 코어가 다시 만들어져 다시 구독함
    expect(err[0]).toContain('감시를 다시 시작합니다 (1/3): boom');

    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 1));
    await ready(net, 3);
    expect(err[1]).toContain('(2/3)');

    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 1));
    expect(await done).toBe(9);
    expect(err.at(-1)).toContain('3번 연속');
    expect(err.at(-1)).toContain('예:');
    expect(net.sockets.every((s) => s.closed)).toBe(true);
    expect(await logText()).toContain('internal error: boom');
  });

  it('한동안 정상으로 돈 뒤의 오류는 연속으로 세지 않는다', async () => {
    const { rt, net, clock, proc, started } = await setup([price('BTCUSDT', 1e9)], { timing: { healthyMs: 1000 } });
    const done = rt.runForeground();
    await started();
    throwing(rt);
    for (let i = 1; i <= 4; i++) {
      await ready(net, i);
      clock.advance(5000); // 정상 구간
      net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 1));
    }
    await ready(net, 5);
    expect(await Promise.race([done, sleep(150).then(() => 'running')])).toBe('running');
    proc.emit('SIGINT');
    expect(await done).toBe(0);
  });

  it('처리되지 않은 예외와 거부된 Promise도 같은 경로로 복구한다', async () => {
    const { rt, net, err, proc, started } = await setup([price('BTCUSDT', 1e9)]);
    const done = rt.runForeground();
    await started();
    proc.emit('uncaughtException', new Error('late failure'));
    await ready(net, 2);
    expect(err[0]).toContain('late failure');
    proc.emit('SIGINT');
    expect(await done).toBe(0);
  });

  it('오류 메시지의 키 형태 문자열은 마스킹한다 (NFR-SEC-01)', async () => {
    const { rt, net, err, proc, started, logText } = await setup([price('BTCUSDT', 1e9)]);
    const done = rt.runForeground();
    await started();
    rt.bus.on('market.ticker', () => { throw new Error('failed with key ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab'); });
    net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 1));
    await waitFor(() => err.length > 0);
    expect(err[0]).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab');
    expect(await logText()).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab');
    proc.emit('SIGINT');
    await done;
  });
});

const waitForAsync = async (cond: () => Promise<boolean>, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('runtime 시작 조건 (NFR-LEGAL-01)', () => {
  it('고지에 동의하지 않았으면 감시를 시작하지 않고 init을 안내한다 (종료 코드 1)', async () => {
    const s = await setup([price('BTCUSDT', 70000)]);
    await s.store.updateConfig((c) => {
      c.disclaimerAccepted = false;
    });
    await expect(s.rt.runForeground()).rejects.toMatchObject({ messageKey: 'err.runNeedInit', exitCode: 1 });
    expect(s.net.sockets).toHaveLength(0);
    expect(await s.store.readRunLock()).toBeUndefined();
  });
});

describe('runtime 일부 시장만 연결될 때 (B10, NFR-REL-02)', () => {
  it('선물 연결이 안 돼도 현물은 감시를 시작하고, 감시하지 못하는 규칙 수를 알린 뒤 복구되면 알린다', async () => {
    const s = await setup([price('BTCUSDT', 70000), funding]);
    s.net.refuse = (url) => url.includes('fstream');
    const done = s.rt.runForeground();
    await s.started('감시 시작'); // 종료 코드 3으로 끝나지 않는다
    const text = s.out.join('\n');
    expect(text).toContain('선물 시장에 연결하지 못했습니다. 이 시장의 알림 1개는 지금 감시하지 못합니다');
    expect(text).toContain('연결이 끊겼습니다'); // 재시도 중

    // 연결된 현물은 정상 동작한다
    s.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 69_000));
    s.net.push('btcusdt@miniTicker', miniTicker('BTCUSDT', 70_010));
    await waitFor(() => s.out.some((l) => l.includes('BTC 70,000 돌파')));

    s.net.refuse = false; // 선물 서버 복구
    await waitFor(() => s.out.some((l) => l.includes('선물 시장 연결이 복구되었습니다')), 5000);
    expect(s.out.join('\n')).toContain('이 시장의 알림도 감시합니다');
    expect(await s.logText()).toContain('futures connection recovered');

    s.proc.emit('SIGINT');
    expect(await done).toBe(0);
  });

  it('필요한 시장이 모두 연결되지 않으면 종료 코드 3 (일부만 실패했을 때와 구분)', async () => {
    const s = await setup([price('BTCUSDT', 70000), funding]);
    s.net.refuse = true;
    expect(await s.rt.runForeground()).toBe(3);
    expect(s.err[0]).toContain('(spot, futures)');
  });
});

describe('runtime 중복 실행 방지·비정상 종료 감지 (blert.pid, NFR-REL-02)', () => {
  it('이미 실행 중이면 두 번째 실행을 거부하고, 첫 실행이 끝나면 다시 시작할 수 있다', async () => {
    const a = await setup([price('BTCUSDT', 1e9)]);
    const doneA = a.rt.runForeground();
    await a.started();

    const b = await setup([]); // 같은 설정 폴더
    await expect(b.rt.runForeground()).rejects.toMatchObject({ messageKey: 'err.runAlready', exitCode: 1 });
    expect(b.net.sockets).toHaveLength(0);

    a.proc.emit('SIGINT');
    await doneA;
    expect(await a.store.readRunLock()).toBeUndefined();

    const c = await setup([]);
    const doneC = c.rt.runForeground();
    await c.started();
    c.proc.emit('SIGINT');
    expect(await doneC).toBe(0);
  });

  it('생존 신호를 주기적으로 갱신한다', async () => {
    const s = await setup([price('BTCUSDT', 1e9)], { timing: { heartbeatMs: 20 } });
    const done = s.rt.runForeground();
    await s.started();
    expect((await s.store.readRunLock())!.heartbeatAt).toBe(iso(T0));
    s.clock.advance(5000);
    await waitForAsync(async () => (await s.store.readRunLock())?.heartbeatAt === iso(T0 + 5000));
    s.proc.emit('SIGINT');
    await done;
  });

  it('이전 실행이 정상 종료하지 못했으면(주인이 죽은 잠금 파일) 그 구간을 감시 중단으로 알리고 잠금을 가져온다', async () => {
    const s = await setup([price('BTCUSDT', 1e9)]);
    // 10분 전까지 살아 있던 프로세스가 죽으면서 남긴 파일 (존재하지 않는 PID)
    await writePidFile(join(dir, 'blert.pid'), { schemaVersion: 1, pid: 2_147_483_646, startedAt: iso(T0 - 40 * MIN), heartbeatAt: iso(T0 - 10 * MIN) });
    const done = s.rt.runForeground();
    await waitFor(() => s.out.some((l) => l.includes('감시 중단 구간 있음')));
    const line = s.out.find((l) => l.includes('감시 중단 구간 있음'))!;
    expect(line).toContain(`${clockHM(T0 - 10 * MIN)} ~ ${clockHM(T0)} 동안 감시하지 못함`);
    expect(await s.logText()).toContain('did not exit cleanly');
    expect((await s.store.readRunLock())?.pid).toBe(process.pid);
    s.proc.emit('SIGINT');
    await done;
  });

  it('프로세스 번호가 살아 있어도 생존 신호가 오래 끊긴 파일은 낡은 것으로 보고 가져온다 (번호 재사용 대비)', async () => {
    const s = await setup([price('BTCUSDT', 1e9)]);
    await writePidFile(join(dir, 'blert.pid'), { schemaVersion: 1, pid: process.pid, startedAt: iso(T0 - 20 * MIN), heartbeatAt: iso(T0 - 5 * MIN) });
    const done = s.rt.runForeground();
    await waitFor(() => s.out.some((l) => l.includes('감시 중단 구간 있음')));
    s.proc.emit('SIGINT');
    expect(await done).toBe(0);
  });

  it('정상 종료한 뒤에는 중단 구간 안내가 없다', async () => {
    const s = await setup([price('BTCUSDT', 1e9)]);
    const done = s.rt.runForeground();
    await s.started();
    s.proc.emit('SIGINT');
    await done;
    const again = await setup([]);
    const done2 = again.rt.runForeground();
    await again.started();
    expect(again.out.join('\n')).not.toContain('감시 중단 구간');
    again.proc.emit('SIGINT');
    await done2;
  });
});
