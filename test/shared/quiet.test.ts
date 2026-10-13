import { describe, expect, it } from 'vitest';
import { activeQuiet, isMuted, minuteOfDay, parseHm, scheduleActive, snoozeActive, SNOOZE_MAX_MS } from '../../src/shared/quiet.js';

// 시각은 현지 시각으로 만든다 (OS 시간대와 무관하게 같은 결과)
const at = (h: number, m: number, s = 0): number => new Date(2026, 9, 13, h, m, s).getTime();
const scope = { all: false, includeWarn: false };

describe('조용한 시간 판정 (FR-NOTI-06)', () => {
  it('AC-121 HH:MM만 받는다 (24시간제, 00:00~23:59)', () => {
    expect(parseHm('23:00')).toBe(23 * 60);
    expect(parseHm('00:00')).toBe(0);
    expect(parseHm('7:00')).toBeUndefined();
    expect(parseHm('24:00')).toBeUndefined();
    expect(parseHm('12:60')).toBeUndefined();
    expect(parseHm('12:00:00')).toBeUndefined();
    expect(parseHm(undefined)).toBeUndefined();
    expect(minuteOfDay(at(13, 45, 59))).toBe(13 * 60 + 45);
  });

  it('AC-121 같은 날 구간: 시작은 포함하고 끝은 포함하지 않는다', () => {
    const s = { ...scope, from: '09:00', to: '17:30' };
    expect(scheduleActive(s, at(8, 59, 59))).toBe(false);
    expect(scheduleActive(s, at(9, 0))).toBe(true);
    expect(scheduleActive(s, at(17, 29, 59))).toBe(true);
    expect(scheduleActive(s, at(17, 30))).toBe(false);
  });

  it('AC-121 자정을 넘기는 구간 (23:00-07:00)', () => {
    const s = { ...scope, from: '23:00', to: '07:00' };
    expect(scheduleActive(s, at(22, 59, 59))).toBe(false);
    expect(scheduleActive(s, at(23, 0))).toBe(true);
    expect(scheduleActive(s, at(0, 0))).toBe(true);
    expect(scheduleActive(s, at(3, 30))).toBe(true);
    expect(scheduleActive(s, at(6, 59, 59))).toBe(true);
    expect(scheduleActive(s, at(7, 0))).toBe(false);
    expect(scheduleActive(s, at(12, 0))).toBe(false);
  });

  it('AC-121 시작과 끝이 같거나 값이 이상하면 구간이 없는 것으로 본다 (손상된 설정에도 죽지 않는다)', () => {
    expect(scheduleActive({ ...scope, from: '09:00', to: '09:00' }, at(9, 0))).toBe(false);
    for (const bad of [undefined, null, 'x', 7, [], { from: '09:00' }, { from: 9, to: 10 }, { from: '25:00', to: '01:00' }]) {
      expect(scheduleActive(bad, at(9, 30))).toBe(false);
    }
  });

  it('AC-119 잠깐 쉬기는 끝나는 시각까지만 켜져 있다 (주입한 시각)', () => {
    const until = new Date(at(14, 0)).toISOString();
    const s = { ...scope, until };
    expect(snoozeActive(s, at(13, 59, 59))).toBe(true);
    expect(snoozeActive(s, at(14, 0))).toBe(false);
    expect(snoozeActive(s, at(15, 0))).toBe(false);
    for (const bad of [undefined, null, {}, { until: 5 }, { until: 'not a date' }]) expect(snoozeActive(bad, at(9, 0))).toBe(false);
    expect(SNOOZE_MAX_MS).toBe(7 * 24 * 3600 * 1000);
  });

  it('AC-122 겹치면 더 많이 끄는 쪽을 따르고, 둘 다 꺼져 있으면 조용하지 않다', () => {
    const until = new Date(at(12, 0)).toISOString();
    const q = { schedule: { from: '09:00', to: '18:00', all: false, includeWarn: true }, snooze: { until, all: true, includeWarn: false } };
    expect(activeQuiet(q, at(10, 0))).toEqual({ all: true, includeWarn: true });
    expect(activeQuiet(q, at(13, 0))).toEqual({ all: false, includeWarn: true }); // 잠깐 쉬기는 끝남
    expect(activeQuiet(q, at(19, 0))).toBeUndefined();
    expect(activeQuiet(undefined, at(10, 0))).toBeUndefined();
    expect(activeQuiet('garbage', at(10, 0))).toBeUndefined();
    expect(activeQuiet({}, at(10, 0))).toBeUndefined();
  });

  it('AC-122 warn은 기본으로 예외이고 includeWarn일 때만 조용히 한다', () => {
    expect(isMuted(undefined, 'up')).toBe(false);
    expect(isMuted({ all: false, includeWarn: false }, 'up')).toBe(true);
    expect(isMuted({ all: false, includeWarn: false }, 'account')).toBe(true);
    expect(isMuted({ all: false, includeWarn: false }, 'warn')).toBe(false);
    expect(isMuted({ all: true, includeWarn: false }, 'warn')).toBe(false);
    expect(isMuted({ all: false, includeWarn: true }, 'warn')).toBe(true);
  });
});
