import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_MS, Notifier } from '../../src/notify/index.js';
import type { NotifyAdapter } from '../../src/notify/adapters.js';
import type { HistoryEntry } from '../../src/shared/history.js';
import type { QuietScope } from '../../src/shared/quiet.js';
import { iso } from '../../src/shared/clock.js';
import type { Alert } from '../../src/shared/types.js';

const T0 = Date.UTC(2026, 9, 13, 5, 0, 0);
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
  constructor(
    readonly name: string,
    readonly wantsAll = false,
  ) {}
  async send(alerts: Alert[]): Promise<void> {
    this.batches.push(alerts);
  }
  get count(): number {
    return this.batches.flat().length;
  }
}

function setup(o: { scope?: () => QuietScope | undefined | Promise<QuietScope | undefined>; recordThrows?: boolean } = {}) {
  const names = ['console', 'desktop', 'sound', 'voice', 'telegram'] as const;
  const a = Object.fromEntries(names.map((n) => [n, new Recorder(n, n === 'console')])) as Record<(typeof names)[number], Recorder>;
  const recorded: HistoryEntry[][] = [];
  const logs: string[] = [];
  const notifier = new Notifier({
    adapters: names.map((n) => a[n]),
    warn: () => {},
    clock: { now: () => Date.now() },
    logger: { info: () => {}, warn: (_m: string, t: string) => void logs.push(t), error: () => {}, debug: () => {} } as never,
    platform: 'win32',
    ...(o.scope ? { quiet: o.scope } : {}),
    record: (e) => {
      if (o.recordThrows) throw new Error('disk full');
      recorded.push(e);
    },
  });
  return { notifier, a, recorded, logs };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('조용한 시간 (FR-NOTI-06, D-136, D-137)', () => {
  it('AC-119 조용한 시간이 아니면 모든 어댑터가 받는다', async () => {
    const { notifier, a } = setup({ scope: () => undefined });
    notifier.notify(alert('up'));
    await tick(HOLD_MS + 10);
    for (const x of Object.values(a)) expect(x.count, x.name).toBe(1);
  });

  it('AC-119 기본은 소리·음성만 건너뛰고 화면·콘솔·채널은 그대로 보낸다', async () => {
    const { notifier, a } = setup({ scope: () => ({ all: false, includeWarn: false }) });
    notifier.notify(alert('up'));
    await tick(HOLD_MS + 10);
    expect(a.sound.count).toBe(0);
    expect(a.voice.count).toBe(0);
    expect(a.desktop.count).toBe(1);
    expect(a.console.count).toBe(1);
    expect(a.telegram.count).toBe(1);
  });

  it('AC-122 --all이면 화면 알림과 채널까지 건너뛰지만 콘솔(터미널 출력)은 남긴다', async () => {
    const { notifier, a } = setup({ scope: () => ({ all: true, includeWarn: false }) });
    notifier.notify(alert('down'));
    await tick(HOLD_MS + 10);
    expect(a.sound.count + a.voice.count + a.desktop.count + a.telegram.count).toBe(0);
    expect(a.console.count).toBe(1);
  });

  it('AC-122 warn은 기본으로 조용한 시간에도 모든 어댑터에 간다', async () => {
    const { notifier, a } = setup({ scope: () => ({ all: true, includeWarn: false }) });
    notifier.notify(alert('warn'));
    await tick(10);
    for (const x of Object.values(a)) expect(x.count, x.name).toBe(1);
  });

  it('AC-122 --include-warn이면 warn도 조용히 한다 (기본 범위에서는 소리·음성만)', async () => {
    const { notifier, a } = setup({ scope: () => ({ all: false, includeWarn: true }) });
    notifier.notify(alert('warn'));
    await tick(10);
    expect(a.sound.count + a.voice.count).toBe(0);
    expect(a.desktop.count).toBe(1);
    expect(a.console.count).toBe(1);
  });

  it('AC-119 묶음 요약도 조용한 시간을 따르고, 콘솔에는 개별 알림 전체가 남는다', async () => {
    const { notifier, a } = setup({ scope: () => ({ all: false, includeWarn: false }) });
    for (let i = 0; i < 4; i++) notifier.notify(alert('up', { ruleId: i + 1 }));
    await tick(HOLD_MS + 10);
    expect(a.sound.count).toBe(0);
    expect(a.desktop.batches).toHaveLength(1);
    expect(a.desktop.batches[0]![0]!.titleKey).toBe('alert.batch.title'); // 요약 1건은 화면에 뜬다
    expect(a.console.count).toBe(4);
  });

  it('AC-123 판정은 알림을 보낼 때마다 하므로 설정 변경이 다음 알림부터 반영된다', async () => {
    let scope: QuietScope | undefined;
    const { notifier, a } = setup({ scope: () => scope });
    notifier.notify(alert('up'));
    await tick(HOLD_MS + 10);
    expect(a.sound.count).toBe(1);
    scope = { all: false, includeWarn: false };
    notifier.notify(alert('up'));
    await tick(HOLD_MS + 10);
    expect(a.sound.count).toBe(1); // 조용해진 뒤에는 늘지 않는다
    scope = undefined;
    notifier.notify(alert('up'));
    await tick(HOLD_MS + 10);
    expect(a.sound.count).toBe(2);
  });

  it('AC-119 판정이 실패하면 조용하지 않은 것으로 보고 알림을 보낸다', async () => {
    const { notifier, a, logs } = setup({
      scope: () => {
        throw new Error('config unreadable');
      },
    });
    notifier.notify(alert('up'));
    await tick(HOLD_MS + 10);
    expect(a.sound.count).toBe(1);
    expect(logs.join()).toContain('quiet check failed');
  });

  it('AC-119 blert test는 조용한 시간에도 울린다', async () => {
    const { notifier, a } = setup({ scope: () => ({ all: true, includeWarn: true }) });
    await notifier.test('up');
    for (const x of Object.values(a)) expect(x.count, x.name).toBe(1);
  });
});

describe('알림 기록 연결 (FR-HIST-01, D-142)', () => {
  it('AC-124 발동한 알림은 기록하고, 조용히 처리된 것에는 표시가 붙는다', async () => {
    let scope: QuietScope | undefined;
    const { notifier, recorded } = setup({ scope: () => scope });
    notifier.notify(alert('up', { ruleId: 7 }));
    await tick(HOLD_MS + 10);
    scope = { all: false, includeWarn: false };
    notifier.notify(alert('down', { ruleId: 8 }));
    await tick(HOLD_MS + 10);
    scope = { all: true, includeWarn: false };
    notifier.notify(alert('account', { ruleId: 9 }));
    await tick(HOLD_MS + 10);
    notifier.notify(alert('warn', { ruleId: 10 })); // warn은 조용히 처리되지 않았으므로 표시가 없다
    await tick(10);
    const e = recorded.flat();
    expect(e.map((x) => [x.ruleId, x.quiet])).toEqual([[7, undefined], [8, 'sound'], [9, 'all'], [10, undefined]]);
    expect(e[0]).toMatchObject({ kind: 'up', titleKey: 'alert.price.above.title', params: { coin: 'BTC' } });
  });

  it('AC-124 묶음 요약이 나가도 기록은 묶이기 전의 개별 알림이다', async () => {
    const { notifier, recorded } = setup();
    for (let i = 0; i < 5; i++) notifier.notify(alert('up', { ruleId: i + 1 }));
    await tick(HOLD_MS + 10);
    const e = recorded.flat();
    expect(e).toHaveLength(5);
    expect(e.every((x) => x.titleKey === 'alert.price.above.title')).toBe(true);
  });

  it('AC-124 감시 시작 같은 공지와 blert test는 기록하지 않는다. 공지는 조용한 시간을 따른다', async () => {
    const { notifier, a, recorded } = setup({ scope: () => ({ all: true, includeWarn: false }) });
    notifier.announce(alert('up', { titleKey: 'alert.start.title' }));
    await tick(10);
    await notifier.test('up');
    expect(recorded).toHaveLength(0);
    expect(a.desktop.count).toBe(1); // 공지는 --all에서 화면에 뜨지 않고, test만 뜬다
    expect(a.console.count).toBe(2);
  });

  it('AC-124 기록 쓰기가 실패해도 알림은 정상으로 나간다', async () => {
    const { notifier, a, logs } = setup({ recordThrows: true });
    notifier.notify(alert('up'));
    await tick(HOLD_MS + 10);
    expect(a.desktop.count).toBe(1);
    expect(logs.join()).toContain('history record failed');
  });
});
