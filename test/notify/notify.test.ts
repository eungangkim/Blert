import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import { GAP_MERGE_MS, HOLD_MS, Notifier, WINDOW_MS, createNotifier } from '../../src/notify/index.js';
import { ConsoleAdapter, SoundAdapter, type NotifyAdapter } from '../../src/notify/adapters.js';
import { render, clockHM } from '../../src/notify/render.js';
import { Engine } from '../../src/engine/index.js';
import { EventBus } from '../../src/shared/bus.js';
import { DEFAULT_REPEAT } from '../../src/shared/defaults.js';
import { Logger } from '../../src/shared/logger.js';
import { iso } from '../../src/shared/clock.js';
import type { BlertEvent } from '../../src/shared/events.js';
import type { Alert, Rule } from '../../src/shared/types.js';
import { funding, kline, rule, ticker } from '../engine/helpers.js';

const T0 = Date.UTC(2026, 9, 3, 5, 0, 0);
const clock = { now: () => Date.now() };
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const alert = (kind: Alert['kind'] = 'up', extra: Partial<Alert> = {}): Alert => ({
  ruleId: 1,
  kind,
  titleKey: 'alert.price.above.title',
  params: { coin: 'BTC', quote: 'USDT', market: 'spot', target: '70,000', price: '70,012' },
  firedAt: iso(Date.now()),
  ...extra,
});

class Recorder implements NotifyAdapter {
  batches: Alert[][] = [];
  fail = false;
  constructor(
    readonly name: string,
    readonly wantsAll = false,
  ) {}
  async send(alerts: Alert[]): Promise<void> {
    if (this.fail) throw new Error(`${this.name} broke`);
    this.batches.push(alerts);
  }
  get all(): Alert[] {
    return this.batches.flat();
  }
}

function setup(opts: { soundEnabled?: () => boolean } = {}) {
  const desktop = new Recorder('desktop');
  const console_ = new Recorder('console', true);
  const played: string[] = [];
  const sound = new SoundAdapter({
    enabled: opts.soundEnabled ?? (() => true),
    dir: '/s',
    platform: 'darwin',
    run: async (_cmd, args) => void played.push(basename(args[0]!)),
  });
  const warnings: string[] = [];
  const logs: string[] = [];
  const notifier = new Notifier({
    adapters: [console_, desktop, sound],
    sound,
    warn: (t) => warnings.push(t),
    clock,
    logger: new Logger({ write: (l) => logs.push(l) }, 'debug'),
    platform: 'win32',
  });
  return { notifier, desktop, console: console_, played, warnings, logs };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('notify 메시지 형식 (B7)', () => {
  const fired = (rules: Rule[], ...events: BlertEvent[]): Alert[] => {
    const engine = new Engine();
    engine.setRules(rules);
    return events.flatMap((e) => engine.handle(e));
  };

  it('가격 돌파·이탈 문구', () => {
    const up = fired([rule({ type: 'price', direction: 'above', price: 70000 }, { kind: 'once' })], ticker(T0, 69_000), ticker(T0 + 1000, 70_012));
    expect(render(up[0]!)).toEqual({ title: 'BTC 70,000 돌파', body: '현재 70,012 USDT · 현물' });
    const down = fired([rule({ type: 'price', direction: 'below', price: 65000 }, { kind: 'once' })], ticker(T0, 66_000), ticker(T0 + 1000, 64_980));
    expect(render(down[0]!)).toEqual({ title: 'BTC 65,000 이탈', body: '현재 64,980 USDT · 현물' });
  });

  it('변동률·거래량·펀딩비 문구', () => {
    const change = fired(
      [rule({ type: 'change', pct: 5, windowMs: 3_600_000, direction: 'down' }, DEFAULT_REPEAT.change, { symbol: 'ETHUSDT' })],
      ticker(T0, 3412, 'spot', 'ETHUSDT'),
      ticker(T0 + 3_600_000, 3235, 'spot', 'ETHUSDT'),
    );
    expect(render(change[0]!)).toEqual({ title: 'ETH 1시간 \u22125.2%', body: '3,412 → 3,235 USDT · 현물' });

    const MIN = 60_000;
    const vol = fired(
      [rule({ type: 'volume', multiple: 3, shortMs: 5 * MIN, longMs: 60 * MIN }, DEFAULT_REPEAT.volume, { symbol: 'SOLUSDT' })],
      ...Array.from({ length: 60 }, (_, i) => kline(T0 + i * MIN, i >= 55 ? 4000 : 1000, { symbol: 'SOLUSDT', now: T0 + 59 * MIN + 30_000 })),
    );
    expect(render(vol[0]!)).toEqual({ title: 'SOL 거래량 3.2배 급증', body: '5분 거래대금 20.0K USDT (1시간 평균 6.3K)' });

    const fund = fired([rule({ type: 'funding', direction: 'above', pct: 0.05 }, DEFAULT_REPEAT.funding)], funding(T0, 0.04), funding(T0 + 3000, 0.061));
    expect(render(fund[0]!)).toEqual({ title: 'BTC 선물 펀딩비 0.061%', body: '기준 0.05% 초과' });
    const low = fired([rule({ type: 'funding', direction: 'below', pct: -0.05 }, DEFAULT_REPEAT.funding)], funding(T0, -0.04), funding(T0 + 3000, -0.062));
    expect(render(low[0]!)).toEqual({ title: 'BTC 선물 펀딩비 \u22120.062%', body: '기준 \u22120.05% 미만' });
  });
});

describe('notify 폭주 묶음 (D-28)', () => {
  it('AC-19 10초 안에 up 알림 4건이 발동하면 요약 1건, 사운드 1회. warn은 개별 전송', async () => {
    const { notifier, desktop, console: cons, played } = setup();
    notifier.notify(alert('warn', { titleKey: 'alert.gap.title', params: { from: '14:02', to: '14:47' } }));
    await tick(0);
    expect(desktop.all.map((a) => a.titleKey)).toEqual(['alert.gap.title']); // warn은 기다리지 않고 바로
    expect(played).toEqual(['warn.wav']);

    for (const symbol of ['BTC', 'ETH', 'SOL', 'XRP']) notifier.notify(alert('up', { params: { ...alert().params, coin: symbol } }));
    await tick(HOLD_MS);

    const summary = desktop.all.filter((a) => a.titleKey === 'alert.batch.title');
    expect(summary).toHaveLength(1);
    expect(desktop.all).toHaveLength(2); // warn 1건 + 요약 1건
    expect(summary[0]!.params.count).toBe(4);
    expect(render(summary[0]!)).toEqual({
      title: '알림 4건',
      body: 'BTC 70,000 돌파\nETH 70,000 돌파\nSOL 70,000 돌파\n외 1건',
    });
    expect(played).toEqual(['warn.wav', 'up.wav']); // 요약의 사운드는 1회
    expect(cons.all.filter((a) => a.kind === 'up')).toHaveLength(4); // 전체는 콘솔에 개별로 남는다
  });

  it('3건 미만이면 묶지 않고 개별로 보내며, 소리는 묶음당 한 번만 재생한다', async () => {
    const { notifier, desktop, played } = setup();
    notifier.notify(alert('up'));
    notifier.notify(alert('down'));
    await tick(HOLD_MS);
    expect(desktop.batches).toHaveLength(1);
    expect(desktop.all.map((a) => a.kind)).toEqual(['up', 'down']);
    expect(played).toEqual(['up.wav']);
  });

  it('NFR-PERF-01 알림은 모으는 시간(0.5초) 뒤에 바로 나가고, 그 전에는 나가지 않는다', async () => {
    const { notifier, desktop } = setup();
    notifier.notify(alert());
    await tick(HOLD_MS - 1);
    expect(desktop.all).toHaveLength(0);
    await tick(1);
    expect(desktop.all).toHaveLength(1);
    expect(HOLD_MS).toBeLessThanOrEqual(1000);
  });

  it('10초 창에서 이미 2건이 나간 뒤 2건이 더 모이면 요약하고, 창이 지나면 다시 개별로 보낸다', async () => {
    const { notifier, desktop } = setup();
    notifier.notify(alert()); // t=0
    await tick(2000);
    notifier.notify(alert()); // t=2s
    await tick(2000);
    expect(desktop.all.map((a) => a.titleKey)).toEqual(['alert.price.above.title', 'alert.price.above.title']);
    notifier.notify(alert()); // t=4s: 창 안에서 이미 2건
    notifier.notify(alert());
    await tick(HOLD_MS);
    expect(desktop.all.at(-1)).toMatchObject({ titleKey: 'alert.batch.title', params: { count: 2 } });

    await tick(WINDOW_MS + 1000);
    notifier.notify(alert());
    notifier.notify(alert());
    await tick(HOLD_MS);
    expect(desktop.all.slice(-2).every((a) => a.titleKey === 'alert.price.above.title')).toBe(true);
  });

  it('요약의 소리는 첫 알림을 따르고, 첫 알림이 무음이면 무음이다', async () => {
    const loud = setup();
    for (const kind of ['down', 'up', 'up'] as const) loud.notifier.notify(alert(kind));
    await tick(HOLD_MS);
    expect(loud.played).toEqual(['down.wav']);

    const quiet = setup();
    for (let i = 0; i < 3; i++) quiet.notifier.notify(alert('up', { sound: 'off' }));
    await tick(HOLD_MS);
    expect(quiet.played).toEqual([]);
  });

  it('flush는 모아 둔 알림을 기다리지 않고 바로 보낸다', async () => {
    const { notifier, desktop } = setup();
    notifier.notify(alert());
    await notifier.flush();
    expect(desktop.all).toHaveLength(1);
  });
});

describe('notify 소리 (FR-NOTI-02)', () => {
  it('규칙의 --sound 지정과 off를 따른다', async () => {
    const { notifier, desktop, played } = setup();
    notifier.notify(alert('up', { sound: 'warn' }));
    await tick(HOLD_MS);
    notifier.notify(alert('up', { sound: 'off' }));
    await tick(HOLD_MS);
    expect(played).toEqual(['warn.wav']);
    expect(desktop.all).toHaveLength(2); // 알림 자체는 표시된다
  });

  it('AC-18 소리를 끄면 알림만 표시되고, sound test는 설정과 무관하게 재생된다', async () => {
    let enabled = true;
    const { notifier, desktop, played } = setup({ soundEnabled: () => enabled });
    await notifier.soundTest('up');
    expect(played).toEqual(['up.wav']);

    enabled = false; // blert sound off
    await notifier.test('up');
    expect(desktop.all.map((a) => a.titleKey)).toEqual(['alert.test.title']);
    expect(played).toEqual(['up.wav']); // 추가 재생 없음

    await notifier.soundTest('down');
    expect(played).toEqual(['up.wav', 'down.wav']);
  });

  it('소리 재생 실패는 무음으로 계속하고 안내는 한 번만 한다', async () => {
    const warnings: string[] = [];
    const desktop = new Recorder('desktop');
    const sound = new SoundAdapter({ enabled: () => true, dir: '/s', platform: 'linux', run: async () => { throw new Error('spawn paplay ENOENT'); } });
    const notifier = new Notifier({ adapters: [desktop, sound], sound, warn: (t) => warnings.push(t), clock, platform: 'linux' });
    notifier.notify(alert());
    await tick(HOLD_MS);
    notifier.notify(alert());
    await tick(HOLD_MS);
    expect(desktop.all).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('무음으로 계속');
    expect(warnings[0]).toContain('pulseaudio-utils');
  });
});

describe('notify 실패 처리 (B7)', () => {
  it('AC-17 데스크톱 알림이 실패하면 콘솔 출력은 유지하고 원인과 권한 안내를 한 번만 보여준다', async () => {
    const { notifier, desktop, console: cons, warnings, logs } = setup();
    desktop.fail = true;
    notifier.notify(alert());
    await tick(HOLD_MS);
    notifier.notify(alert());
    await tick(HOLD_MS);
    expect(cons.all).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('콘솔로 대신 보여줍니다');
    expect(warnings[0]).toContain('desktop broke');
    expect(warnings[0]).toContain('집중 지원'); // Windows 안내
    expect(logs.filter((l) => l.includes('desktop adapter failed'))).toHaveLength(2);
  });

  it('한 어댑터가 실패해도 다른 어댑터는 계속 전달받는다', async () => {
    const { notifier, desktop, console: cons, played } = setup();
    desktop.fail = true;
    notifier.notify(alert());
    await tick(HOLD_MS);
    expect(cons.all).toHaveLength(1);
    expect(played).toEqual(['up.wav']);
  });

  it('OS별 안내 문구를 고른다', async () => {
    for (const [platform, expected] of [['darwin', '터미널 앱'], ['linux', 'libnotify-bin']] as const) {
      const warnings: string[] = [];
      const desktop = new Recorder('desktop');
      desktop.fail = true;
      const notifier = new Notifier({ adapters: [desktop], warn: (t) => warnings.push(t), clock, platform });
      notifier.notify(alert('warn'));
      await tick(0);
      expect(warnings[0], platform).toContain(expected);
    }
  });
});

describe('notify 이벤트 연동', () => {
  it('rule.fired를 받아 내보낸다', async () => {
    const { notifier, desktop } = setup();
    const bus = new EventBus();
    notifier.attach(bus);
    bus.emit({ type: 'rule.fired', ts: iso(T0), alert: alert() });
    await tick(HOLD_MS);
    expect(desktop.all).toHaveLength(1);
  });

  it('5분 넘는 끊김(ongoing)은 지속 시간과 재시도 횟수를 담은 warn으로 즉시 알린다', async () => {
    const { notifier, desktop } = setup();
    const bus = new EventBus();
    notifier.attach(bus);
    bus.emit({ type: 'conn.status', ts: iso(T0), stream: 'spot', state: 'retrying', attempt: 12 });
    bus.emit({ type: 'conn.status', ts: iso(T0), stream: 'futures', state: 'open', attempt: 0 });
    bus.emit({ type: 'conn.gap', ts: iso(T0), from: iso(T0 - 5 * 60_000), to: iso(T0), reason: 'disconnect', ongoing: true });
    await tick(GAP_MERGE_MS);
    expect(desktop.all).toHaveLength(1);
    expect(desktop.all[0]).toMatchObject({ kind: 'warn', titleKey: 'alert.conn.down.title', params: { minutes: 5, attempt: 12 } });
    expect(render(desktop.all[0]!)).toEqual({ title: '바이낸스 연결 끊김 5분', body: '재연결 시도 중 (12회)' });
  });

  it('끝난 감시 중단 구간은 시작~종료 시각을 담은 warn으로 알린다 (끊김·절전 공통)', async () => {
    const { notifier, desktop } = setup();
    const bus = new EventBus();
    notifier.attach(bus);
    const from = T0 - 45 * 60_000;
    bus.emit({ type: 'conn.gap', ts: iso(T0), from: iso(from), to: iso(T0), reason: 'sleep' });
    await tick(GAP_MERGE_MS);
    expect(desktop.all).toHaveLength(1);
    expect(render(desktop.all[0]!)).toEqual({
      title: '감시 중단 구간 있음',
      body: `${clockHM(from)} ~ ${clockHM(T0)} 동안 감시하지 못함`,
    });
  });
});

describe('notify 중단 구간 합치기 (NFR-REL-02)', () => {
  const gap = (bus: EventBus, from: number, to: number, ongoing = false) =>
    bus.emit({ type: 'conn.gap', ts: iso(to), from: iso(from), to: iso(to), reason: 'disconnect', ...(ongoing ? { ongoing: true } : {}) });

  it('AC-21 한 번의 끊김을 현물·선물·계정 연결이 따로 보고해도 알림과 소리는 한 번이고, 가장 이른 시작~가장 늦은 끝을 담는다', async () => {
    const { notifier, desktop, played } = setup();
    const bus = new EventBus();
    notifier.attach(bus);
    gap(bus, T0 - 16_000, T0); // spot
    await tick(55);
    gap(bus, T0 - 15_990, T0 + 55); // futures
    await tick(140);
    gap(bus, T0 - 15_980, T0 + 195); // futures-account
    await tick(GAP_MERGE_MS);
    expect(desktop.all).toHaveLength(1);
    expect(played).toHaveLength(1);
    expect(desktop.all[0]).toMatchObject({ kind: 'warn', titleKey: 'alert.gap.title' });
    expect(desktop.all[0]!.params).toEqual({ from: clockHM(T0 - 16_000), to: clockHM(T0 + 195) });
  });

  it('합치는 시간이 지난 뒤의 새 끊김은 따로 알린다', async () => {
    const { notifier, desktop } = setup();
    const bus = new EventBus();
    notifier.attach(bus);
    gap(bus, T0 - 60_000, T0);
    await tick(GAP_MERGE_MS);
    gap(bus, T0 + 10 * 60_000, T0 + 11 * 60_000);
    await tick(GAP_MERGE_MS);
    expect(desktop.all).toHaveLength(2);
  });

  it('5분 넘게 이어지는 끊김 경고(ongoing)도 연결마다 중복되지 않고, 끝난 구간 알림과는 따로 나간다', async () => {
    const { notifier, desktop } = setup();
    const bus = new EventBus();
    notifier.attach(bus);
    for (let i = 0; i < 3; i++) gap(bus, T0 - 5 * 60_000 - i, T0, true);
    gap(bus, T0 - 60_000, T0);
    await tick(GAP_MERGE_MS);
    expect(desktop.all.map((a) => a.titleKey).sort()).toEqual(['alert.conn.down.title', 'alert.gap.title']);
  });

  it('종료할 때(flush) 합치는 중인 구간 알림도 잃지 않고 보낸다', async () => {
    const { notifier, desktop } = setup();
    const bus = new EventBus();
    notifier.attach(bus);
    gap(bus, T0 - 60_000, T0);
    await notifier.flush();
    expect(desktop.all).toHaveLength(1);
    await tick(GAP_MERGE_MS * 2);
    expect(desktop.all).toHaveLength(1); // 타이머가 남아 두 번 나가지 않는다
  });
});

describe('notify 중단 구간 표기', () => {
  it('구간이 날짜를 넘으면 날짜를 함께 보여주고, 이전 실행 비정상 종료(exit)도 같은 알림으로 보여준다', async () => {
    const { notifier, desktop } = setup();
    const bus = new EventBus();
    notifier.attach(bus);
    const from = T0 - 30 * 3_600_000;
    bus.emit({ type: 'conn.gap', ts: iso(T0), from: iso(from), to: iso(T0), reason: 'exit' });
    await tick(GAP_MERGE_MS);
    const f = new Date(from);
    const t = new Date(T0);
    expect(render(desktop.all[0]!).body).toBe(
      `${f.getMonth() + 1}/${f.getDate()} ${clockHM(from)} ~ ${t.getMonth() + 1}/${t.getDate()} ${clockHM(T0)} 동안 감시하지 못함`,
    );
  });
});

describe('notify 콘솔 출력', () => {
  it('시각·종류 표시·제목·본문을 한 줄로 출력한다', async () => {
    const lines: string[] = [];
    await new ConsoleAdapter((l) => lines.push(l), () => T0).send([alert('up'), alert('warn', { titleKey: 'alert.gap.title', params: { from: '14:02', to: '14:47' } })]);
    expect(lines[0]).toMatch(/^\d\d:\d\d:\d\d \u25B2 BTC 70,000 돌파 \u2014 현재 70,012 USDT · 현물$/);
    expect(lines[1]).toMatch(/^\d\d:\d\d:\d\d ! 감시 중단 구간 있음 \u2014 14:02 ~ 14:47 동안 감시하지 못함$/);
  });

  it('createNotifier는 콘솔·데스크톱·소리를 갖추고 console:false면 콘솔을 끈다', async () => {
    const calls: string[] = [];
    const run = async (cmd: string) => void calls.push(cmd);
    const out: string[] = [];
    const n1 = createNotifier({ out: (l) => out.push(l), soundEnabled: () => true, platform: 'linux', run, clock });
    await n1.test('up');
    expect(out).toHaveLength(1);
    expect(calls).toEqual(['notify-send', 'paplay']);
    const n2 = createNotifier({ out: (l) => out.push(l), soundEnabled: () => true, platform: 'linux', run, clock, console: false });
    await n2.test('up');
    expect(out).toHaveLength(1);
  });
});
