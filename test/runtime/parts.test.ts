import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SleepDetector } from '../../src/runtime/sleep.js';
import { FileLogSink } from '../../src/runtime/logsink.js';
import { FakeClock } from '../../src/shared/clock.js';
import { EventBus } from '../../src/shared/bus.js';
import type { BlertEvent } from '../../src/shared/events.js';

describe('SleepDetector (B9 절전 복귀 감지)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('15초마다 확인하고, 시계가 60초 이상 건너뛰었으면 마지막 확인 시각부터 지금까지를 알린다', () => {
    const clock = new FakeClock(1_000_000);
    const wakes: [number, number][] = [];
    const d = new SleepDetector({ clock, onWake: (f, t) => wakes.push([f, t]) });
    d.start();

    clock.advance(15_000);
    vi.advanceTimersByTime(15_000);
    clock.advance(15_000);
    vi.advanceTimersByTime(15_000);
    expect(wakes).toEqual([]); // 정상 흐름

    clock.advance(90_000); // 덮개를 닫았다 연 것처럼 시계만 건너뜀
    vi.advanceTimersByTime(15_000);
    expect(wakes).toEqual([[1_030_000, 1_120_000]]);

    vi.advanceTimersByTime(15_000); // 이후에는 다시 정상
    expect(wakes).toHaveLength(1);
    d.stop();
  });

  it('60초 미만은 무시하고, stop하면 더 이상 확인하지 않는다', () => {
    const clock = new FakeClock(0);
    const onWake = vi.fn();
    const d = new SleepDetector({ clock, onWake });
    d.start();
    clock.advance(59_999);
    vi.advanceTimersByTime(15_000);
    expect(onWake).not.toHaveBeenCalled();
    d.stop();
    clock.advance(600_000);
    vi.advanceTimersByTime(60_000);
    expect(onWake).not.toHaveBeenCalled();
  });

  it('onWake가 던져도 다음 확인은 계속된다', () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const d = new SleepDetector({
      clock,
      onWake: () => {
        calls++;
        throw new Error('handler failed');
      },
    });
    d.start();
    clock.advance(100_000);
    expect(() => vi.advanceTimersByTime(15_000)).toThrow('handler failed');
    clock.advance(100_000);
    expect(() => vi.advanceTimersByTime(15_000)).toThrow('handler failed');
    expect(calls).toBe(2);
    d.stop();
  });
});

describe('FileLogSink (B8 로그 보관)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blert-log-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('날짜별 파일에 한 줄씩 덧붙이고 날짜가 바뀌면 새 파일을 만든다', async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 3, 23, 59, 0));
    const sink = new FileLogSink(join(dir, 'logs'), clock);
    sink.write('line one');
    sink.write('line two');
    clock.advance(2 * 60_000);
    sink.write('line three');
    expect(await readdir(join(dir, 'logs'))).toEqual(['blert-2026-10-03.log', 'blert-2026-10-04.log']);
    expect(await readFile(join(dir, 'logs', 'blert-2026-10-03.log'), 'utf8')).toBe('line one\nline two\n');
  });

  it('7일이 지난 로그는 지운다', async () => {
    const logs = join(dir, 'logs');
    await mkdir(logs);
    for (const day of ['2026-09-20', '2026-09-26', '2026-09-27', '2026-10-02']) await writeFile(join(logs, `blert-${day}.log`), 'x\n');
    await writeFile(join(logs, 'other.txt'), 'keep');
    const sink = new FileLogSink(logs, new FakeClock(Date.UTC(2026, 9, 3, 12)));
    sink.write('today');
    expect((await readdir(logs)).sort()).toEqual(['blert-2026-09-27.log', 'blert-2026-10-02.log', 'blert-2026-10-03.log', 'other.txt']);
  });

  it('전체가 한도(10MB)를 넘으면 오래된 파일부터 지우되 최신 파일은 남긴다', async () => {
    const logs = join(dir, 'logs');
    await mkdir(logs);
    for (const day of ['2026-10-01', '2026-10-02']) await writeFile(join(logs, `blert-${day}.log`), 'x'.repeat(400));
    const sink = new FileLogSink(logs, new FakeClock(Date.UTC(2026, 9, 3, 12)), 7 * 86_400_000, 1000);
    sink.write('y'.repeat(300)); // 오늘 파일이 생기며 정리 후 추가: 400+400 = 800 ≤ 1000 → 유지
    expect((await readdir(logs)).length).toBe(3);
    sink.prune(); // 800 + 301 > 1000 → 가장 오래된 것 삭제
    expect((await readdir(logs)).sort()).toEqual(['blert-2026-10-02.log', 'blert-2026-10-03.log']);
    const tiny = new FileLogSink(logs, new FakeClock(Date.UTC(2026, 9, 3, 12)), 7 * 86_400_000, 10);
    tiny.prune();
    expect(await readdir(logs)).toEqual(['blert-2026-10-03.log']); // 마지막 하나는 남긴다
  });

  it('쓸 수 없는 경로여도 던지지 않는다', () => {
    const sink = new FileLogSink(join(dir, 'file.txt', 'logs'), new FakeClock(0));
    return writeFile(join(dir, 'file.txt'), 'not a dir').then(() => {
      expect(() => sink.write('x')).not.toThrow();
    });
  });
});

describe('EventBus 오류 처리 (B10)', () => {
  const ev: BlertEvent = { type: 'rules.changed', ts: '', ruleIds: [] };

  it('onError가 있으면 핸들러 예외를 넘기고 다른 핸들러는 계속 실행한다', () => {
    const errors: unknown[] = [];
    const bus = new EventBus({ onError: (e) => errors.push(e) });
    const seen: string[] = [];
    bus.on('rules.changed', () => { throw new Error('first'); });
    bus.on('rules.changed', () => void seen.push('second'));
    expect(() => bus.emit(ev)).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(seen).toEqual(['second']);
  });

  it('onError가 없으면 예외를 그대로 던진다', () => {
    const bus = new EventBus();
    bus.on('rules.changed', () => { throw new Error('boom'); });
    expect(() => bus.emit(ev)).toThrow('boom');
  });
});
