import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers.js';
import { setLanguage } from '../../src/i18n/index.js';
import { RUN_LOCK_STALE_MS } from '../../src/shared/defaults.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const text = (x: Harness): string => [...x.out, ...x.err].join('\n');
/** 현지 시각으로 만든 시각 (OS 시간대와 무관하게 같은 결과) */
const local = (hh: number, mm: number, day = 1): number => new Date(2026, 10, day, hh, mm).getTime();
const HOUR = 3_600_000;

describe('cli snooze (FR-NOTI-06, D-135, D-139)', () => {
  it('AC-119 snooze 1h는 지금부터 1시간 뒤까지 조용히 하고, 기본은 소리·음성만 끄며 경고는 예외다', async () => {
    h = await makeHarness();
    h.sim.nowMs = local(14, 0);
    expect(await h.run('snooze 1h')).toBe(0);
    const q = (await h.deps.store.loadConfig()).quiet;
    expect(q?.snooze).toEqual({ until: new Date(local(15, 0)).toISOString(), all: false, includeWarn: false });
    expect(h.out[0]).toContain('15:00까지(1시간) 조용히 합니다');
    expect(h.out[0]).toContain('소리·음성을 끕니다');
    expect(h.out[0]).toContain('경고는 계속 울립니다');
  });

  it('AC-122 --all과 --include-warn은 범위로 저장된다', async () => {
    h = await makeHarness();
    expect(await h.run('snooze 30m --all --include-warn')).toBe(0);
    expect((await h.deps.store.loadConfig()).quiet?.snooze).toMatchObject({ all: true, includeWarn: true });
    expect(h.out[0]).toContain('화면 알림·외부 채널을 끕니다');
    expect(h.out[0]).toContain('경고도 조용히 합니다');
  });

  it('AC-119 날짜가 넘어가면 끝나는 날짜도 보여 주고, 남은 시간은 일·시간·분으로 보여 준다', async () => {
    h = await makeHarness();
    h.sim.nowMs = local(22, 0);
    await h.run('snooze 630m');
    expect(h.out[0]).toContain('11/2 08:30까지(10시간 30분)');
    h.out.length = 0;
    await h.run('snooze 2d');
    expect(h.out[0]).toContain('(2일)');
  });

  it('AC-120 snooze를 인자 없이 실행하면 남은 시간을 보여 주고, 끝난 뒤에는 꺼짐으로 보인다', async () => {
    h = await makeHarness();
    h.sim.nowMs = local(14, 0);
    await h.run('snooze 2h');
    h.sim.nowMs += HOUR + 30 * 60_000;
    h.out.length = 0;
    expect(await h.run('snooze')).toBe(0);
    expect(h.out[0]).toBe('잠깐 쉬기: 16:00까지(남은 시간 30분) · 소리·음성을 끕니다(화면 알림은 그대로 뜹니다). 청산가 근접·연결 끊김 같은 경고는 계속 울립니다(경고까지 끄려면 --include-warn).');
    h.sim.nowMs += HOUR;
    h.out.length = 0;
    await h.run('snooze');
    expect(h.out[0]).toBe('잠깐 쉬기: 꺼짐 (켜려면 blert snooze 1h)');
  });

  it('AC-120 snooze off는 즉시 해제하고, 켜져 있지 않으면 그렇게 알려 준다', async () => {
    h = await makeHarness();
    await h.run('snooze 1h');
    h.out.length = 0;
    expect(await h.run('snooze off')).toBe(0);
    expect(h.out[0]).toBe('잠깐 쉬기를 해제했습니다.');
    expect((await h.deps.store.loadConfig()).quiet).toBeUndefined();
    h.out.length = 0;
    expect(await h.run('snooze off')).toBe(0);
    expect(h.out[0]).toBe('잠깐 쉬기가 켜져 있지 않습니다.');
  });

  it('AC-120 7일을 넘거나 1분 미만이거나 형식이 틀리면 종료 코드 1과 예시를 안내한다', async () => {
    h = await makeHarness();
    for (const bad of ['8d', '169h', '30s', 'abc', '1', '0m', '-1h']) {
      h.err.length = 0;
      expect(await h.run(`snooze ${bad}`), bad).toBe(1);
      expect(h.err.at(-1), bad).toContain('예');
    }
    expect(await h.run('snooze 7d')).toBe(0); // 7일은 허용
    expect((await h.deps.store.loadConfig()).quiet?.snooze).toBeDefined();
  });

  it('AC-120 인자가 많거나 해제·상태 확인에 옵션을 붙이면 거부한다', async () => {
    h = await makeHarness();
    expect(await h.run('snooze 1h 2h')).toBe(1);
    expect(await h.run('snooze off --all')).toBe(1);
    expect(await h.run('snooze --include-warn')).toBe(1);
    expect((await h.deps.store.loadConfig()).quiet).toBeUndefined();
  });
});

describe('cli quiet (FR-NOTI-06, D-135, D-138)', () => {
  it('AC-121 quiet 23:00-07:00은 매일 반복 구간으로 저장하고 지금이 구간 안인지 알려 준다', async () => {
    h = await makeHarness();
    h.sim.nowMs = local(23, 30);
    expect(await h.run('quiet 23:00-07:00')).toBe(0);
    expect((await h.deps.store.loadConfig()).quiet?.schedule).toEqual({ from: '23:00', to: '07:00', all: false, includeWarn: false });
    expect(h.out[0]).toContain('매일 23:00~07:00에 조용히 합니다');
    expect(h.out[0]).toContain('지금은 조용한 시간입니다');
    h.sim.nowMs = local(12, 0);
    h.out.length = 0;
    await h.run('quiet 23:00-07:00 --all');
    expect(h.out[0]).toContain('지금은 조용한 시간이 아닙니다');
    expect((await h.deps.store.loadConfig()).quiet?.schedule?.all).toBe(true);
  });

  it('AC-121 시작과 끝이 같거나 형식이 틀리면 거부하고 아무것도 저장하지 않는다', async () => {
    h = await makeHarness();
    for (const bad of ['09:00-09:00', '25:00-07:00', '23:00', '7:00-8:00', '23:00-07:60', 'night', '23:00~07:00']) {
      h.err.length = 0;
      expect(await h.run(`quiet ${bad}`), bad).toBe(1);
      expect(h.err.at(-1), bad).toContain('예');
    }
    expect((await h.deps.store.loadConfig()).quiet).toBeUndefined();
  });

  it('AC-121 quiet을 인자 없이 실행하면 상태를 보여 주고 quiet off로 해제한다', async () => {
    h = await makeHarness();
    h.sim.nowMs = local(12, 0);
    await h.run('quiet');
    expect(h.out.at(-1)).toBe('매일 조용한 시간: 꺼짐 (켜려면 blert quiet 23:00-07:00)');
    await h.run('quiet 23:00-07:00');
    h.out.length = 0;
    await h.run('quiet');
    expect(h.out[1]).toContain('매일 조용한 시간: 23:00~07:00 · 지금은 조용한 시간이 아닙니다');
    h.out.length = 0;
    expect(await h.run('quiet off')).toBe(0);
    expect(h.out[0]).toBe('매일 조용한 시간을 해제했습니다.');
    expect((await h.deps.store.loadConfig()).quiet).toBeUndefined();
    h.out.length = 0;
    await h.run('quiet off');
    expect(h.out[0]).toBe('매일 조용한 시간이 설정돼 있지 않습니다.');
    expect(await h.run('quiet off --all')).toBe(1);
  });

  it('AC-121 잠깐 쉬기와 매일 반복은 서로를 지우지 않는다', async () => {
    h = await makeHarness();
    await h.run('snooze 1h');
    await h.run('quiet 23:00-07:00');
    let q = (await h.deps.store.loadConfig()).quiet;
    expect(q?.snooze).toBeDefined();
    expect(q?.schedule).toBeDefined();
    await h.run('snooze off');
    q = (await h.deps.store.loadConfig()).quiet;
    expect(q?.snooze).toBeUndefined();
    expect(q?.schedule).toBeDefined();
    await h.run('quiet off');
    expect((await h.deps.store.loadConfig()).quiet).toBeUndefined();
  });

  it('AC-123 감시(데몬)가 실행 중이어도 재시작 없이 설정만 바꾼다 (알림을 보낼 때마다 읽는다)', async () => {
    h = await makeHarness();
    const r = await h.deps.store.acquireRunLock({ pid: process.pid, now: h.sim.nowMs, staleMs: RUN_LOCK_STALE_MS, mode: 'daemon' });
    expect(r.ok).toBe(true);
    expect(await h.run('snooze 1h')).toBe(0);
    expect(await h.run('quiet 23:00-07:00')).toBe(0);
    expect(text(h)).not.toContain('다시 시작');
    expect(text(h)).not.toContain('restart');
    await h.deps.store.releaseRunLock(process.pid);
  });
});

describe('조용한 시간 설정의 호환 (AC-130)', () => {
  it('AC-130 quiet이 없는 v1.4 설정은 그대로 동작하고, 모르는 항목은 다시 저장해도 보존된다', async () => {
    h = await makeHarness();
    await h.deps.store.updateConfig((c) => {
      (c as unknown as Record<string, unknown>).futureThing = { keep: 'me' };
      c.voice = { enabled: true, kinds: ['warn'] };
    });
    await h.run('snooze 1h');
    await h.run('quiet 23:00-07:00');
    const c = (await h.deps.store.loadConfig()) as unknown as Record<string, unknown>;
    expect(c.futureThing).toEqual({ keep: 'me' });
    expect(c.voice).toEqual({ enabled: true, kinds: ['warn'] });
    expect(c.schemaVersion).toBe(1);
  });

  it('AC-130 손상된 quiet 값이 있어도 명령이 죽지 않고 꺼짐으로 보여 준다', async () => {
    h = await makeHarness();
    await h.deps.store.updateConfig((c) => {
      (c as unknown as Record<string, unknown>).quiet = { snooze: { until: 5 }, schedule: { from: 'x', to: 7 } };
    });
    expect(await h.run('snooze')).toBe(0);
    expect(h.out[0]).toContain('꺼짐');
    expect(h.out[1]).toContain('꺼짐');
    expect(await h.run('quiet off')).toBe(0);
  });
});

describe('영어 (AC-131)', () => {
  it('AC-131 snooze·quiet의 출력과 오류에 한글이 없고 오류는 예시(e.g.)를 담는다', async () => {
    h = await makeHarness();
    setLanguage('en');
    h.sim.nowMs = local(23, 30);
    for (const c of ['snooze 1h', 'snooze', 'snooze off', 'quiet 23:00-07:00 --all --include-warn', 'quiet', 'quiet off']) expect(await h.run(c), c).toBe(0);
    for (const c of ['snooze 9d', 'snooze abc', 'snooze 1h 2h', 'snooze off --all', 'quiet 25:00-07:00', 'quiet 09:00-09:00', 'quiet 1 2', 'quiet off --all']) {
      expect(await h.run(c), c).toBe(1);
    }
    expect(text(h)).not.toMatch(/[가-힣]/);
    expect(h.err.every((e) => /e\.g\./.test(e)), h.err.join('\n')).toBe(true);
    expect(h.out.join('\n')).toContain('Quiet until');
    expect(h.out.join('\n')).toContain('Daily quiet hours');
  });

  it('AC-131 도움말에 두 명령이 나오고 영어 도움말에도 예시가 있다', async () => {
    h = await makeHarness();
    setLanguage('en');
    expect(await h.run('--help')).toBe(0);
    expect(h.out.join('\n')).toMatch(/snooze\s+Go quiet for a while/);
    expect(h.out.join('\n')).toMatch(/quiet\s+Go quiet at the same hours/);
    h.out.length = 0;
    expect(await h.run('quiet --help')).toBe(0);
    expect(h.out.join('\n')).toContain('blert quiet 23:00-07:00');
  });
});

describe('status의 조용한 시간 표시 (D-141)', () => {
  it('AC-119 status는 조용한 시간이 켜져 있을 때만 그 상태를 보여 준다', async () => {
    h = await makeHarness();
    h.sim.nowMs = local(23, 30);
    await h.run('status');
    expect(text(h)).not.toContain('조용');
    await h.run('snooze 1h');
    await h.run('quiet 23:00-07:00');
    h.out.length = 0;
    expect(await h.run('status')).toBe(0);
    expect(text(h)).toContain('잠깐 쉬기: 11/2 00:30까지(남은 시간 1시간)');
    expect(text(h)).toContain('매일 조용한 시간: 23:00~07:00 · 지금은 조용한 시간입니다');
  });
});
