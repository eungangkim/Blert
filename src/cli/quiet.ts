import { BlertError } from '../shared/errors.js';
import { SNOOZE_MAX_MS, parseHm, scheduleActive, snoozeActive, type QuietConfig, type QuietScope } from '../shared/quiet.js';
import { iso } from '../shared/clock.js';
import { t } from '../i18n/index.js';
import { parseDuration } from './parse.js';
import type { Command, Ctx } from './types.js';

const MIN_SNOOZE_MS = 60_000;

/** 남은 시간을 사람이 읽는 말로. 1분 미만이면 "1분 미만" */
export function humanRemaining(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 1) return t('quiet.dur.lessThanMinute');
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d > 0 ? t('quiet.dur.day', { n: d }) : '', h > 0 ? t('quiet.dur.hour', { n: h }) : '', m > 0 ? t('quiet.dur.minute', { n: m }) : ''].filter(Boolean).join(' ');
}

/** 끝나는 시각: 오늘이면 HH:MM, 아니면 M/D HH:MM (현지 시각) */
function untilText(untilMs: number, nowMs: number): string {
  const u = new Date(untilMs);
  const n = new Date(nowMs);
  const p = (x: number) => String(x).padStart(2, '0');
  const hm = `${p(u.getHours())}:${p(u.getMinutes())}`;
  const sameDay = u.getFullYear() === n.getFullYear() && u.getMonth() === n.getMonth() && u.getDate() === n.getDate();
  return sameDay ? hm : `${u.getMonth() + 1}/${u.getDate()} ${hm}`;
}

/** 범위 설명 한 줄. warn 예외 여부까지 알려 준다 (D-136, D-137) */
const scopeText = (s: QuietScope): string => `${t(s.all ? 'quiet.scope.all' : 'quiet.scope.sound')} ${t(s.includeWarn ? 'quiet.warn.included' : 'quiet.warn.exempt')}`;

function scopeFromFlags(ctx: Ctx): QuietScope {
  return { all: ctx.args.flags.has('all'), includeWarn: ctx.args.flags.has('include-warn') };
}

/** 지금의 조용한 시간 상태를 보여 준다 (`snooze`·`quiet`를 인자 없이 실행했을 때, `status`) */
export function quietStatusLines(q: QuietConfig | undefined, nowMs: number): string[] {
  return [snoozeLine(q, nowMs) ?? t('quiet.status.snoozeOff'), scheduleLine(q, nowMs) ?? t('quiet.status.scheduleOff')];
}

/** `blert status`용: 켜져 있는 것만 보여 준다. 둘 다 꺼져 있으면 빈 목록 (D-141) */
export function quietStatusLinesIfOn(q: QuietConfig | undefined, nowMs: number): string[] {
  return [snoozeLine(q, nowMs), scheduleLine(q, nowMs)].filter((l): l is string => l !== undefined);
}

function snoozeLine(q: QuietConfig | undefined, nowMs: number): string | undefined {
  const snooze = q?.snooze;
  if (!snoozeActive(snooze, nowMs)) return undefined;
  const until = Date.parse(snooze.until);
  return t('quiet.status.snooze', { until: untilText(until, nowMs), remaining: humanRemaining(until - nowMs), scope: scopeText(snooze) });
}

function scheduleLine(q: QuietConfig | undefined, nowMs: number): string | undefined {
  const schedule = q?.schedule;
  if (!schedule || parseHm(schedule.from) === undefined || parseHm(schedule.to) === undefined || schedule.from === schedule.to) return undefined;
  return t('quiet.status.schedule', { from: schedule.from, to: schedule.to, now: t(scheduleActive(schedule, nowMs) ? 'quiet.now.on' : 'quiet.now.off'), scope: scopeText(schedule) });
}

const rejectFlags = (ctx: Ctx, usageKey: string): void => {
  if (ctx.args.flags.has('all') || ctx.args.flags.has('include-warn')) throw new BlertError(usageKey);
};

/**
 * `blert snooze <시간>|off` (FR-NOTI-06, D-135, D-139). 설정은 알림을 보낼 때마다 읽으므로 실행 중인 감시도 바로 따른다 (D-140).
 */
export const snoozeCommand: Command = {
  name: 'snooze',
  usageKeys: ['usage.snooze.set', 'usage.snooze.off', 'usage.snooze.show'],
  allowedOptions: ['all', 'include-warn'],
  async run(ctx: Ctx) {
    const { rest, deps } = ctx;
    const { io, store } = deps;
    const now = deps.daemon.now();
    if (rest.length > 1) throw new BlertError('err.snoozeUsage');

    if (rest.length === 0) {
      rejectFlags(ctx, 'err.snoozeFlags');
      quietStatusLines((await store.loadConfig()).quiet, now).forEach((l) => io.out(l));
      return 0;
    }

    const raw = rest[0]!;
    if (raw.toLowerCase() === 'off') {
      rejectFlags(ctx, 'err.snoozeFlags');
      let was = false;
      await store.updateConfig((c) => {
        was = snoozeActive(c.quiet?.snooze, now);
        dropQuiet(c, 'snooze');
      });
      io.out(t(was ? 'snooze.off.done' : 'snooze.off.none'));
      return 0;
    }

    const ms = parseDuration(raw);
    if (ms < MIN_SNOOZE_MS || ms > SNOOZE_MAX_MS) throw new BlertError('err.snoozeRange', { value: raw });
    const scope = scopeFromFlags(ctx);
    const until = now + ms;
    await store.updateConfig((c) => {
      c.quiet = { ...c.quiet, snooze: { until: iso(until), ...scope } };
    });
    io.out(t('snooze.on', { until: untilText(until, now), remaining: humanRemaining(ms), scope: scopeText(scope) }));
    return 0;
  },
};

/** `blert quiet <HH:MM>-<HH:MM>|off` (FR-NOTI-06, D-135, D-138) */
export const quietCommand: Command = {
  name: 'quiet',
  usageKeys: ['usage.quiet.set', 'usage.quiet.off', 'usage.quiet.show'],
  allowedOptions: ['all', 'include-warn'],
  async run(ctx: Ctx) {
    const { rest, deps } = ctx;
    const { io, store } = deps;
    const now = deps.daemon.now();
    if (rest.length > 1) throw new BlertError('err.quietUsage');

    if (rest.length === 0) {
      rejectFlags(ctx, 'err.quietFlags');
      quietStatusLines((await store.loadConfig()).quiet, now).forEach((l) => io.out(l));
      return 0;
    }

    const raw = rest[0]!;
    if (raw.toLowerCase() === 'off') {
      rejectFlags(ctx, 'err.quietFlags');
      let was = false;
      await store.updateConfig((c) => {
        was = c.quiet?.schedule !== undefined;
        dropQuiet(c, 'schedule');
      });
      io.out(t(was ? 'quiet.off.done' : 'quiet.off.none'));
      return 0;
    }

    const m = /^(.+)-(.+)$/.exec(raw);
    const from = parseHm(m?.[1]);
    const to = parseHm(m?.[2]);
    if (!m || from === undefined || to === undefined) throw new BlertError('err.quietFormat', { value: raw });
    if (from === to) throw new BlertError('err.quietSame', { value: raw });
    const scope = scopeFromFlags(ctx);
    const schedule = { from: m[1]!, to: m[2]!, ...scope };
    await store.updateConfig((c) => {
      c.quiet = { ...c.quiet, schedule };
    });
    io.out(t('quiet.set.done', { from: schedule.from, to: schedule.to, scope: scopeText(scope), now: t(scheduleActive(schedule, now) ? 'quiet.now.on' : 'quiet.now.off') }));
    return 0;
  },
};

/** 잠깐 쉬기나 매일 반복 중 하나를 지운다. 둘 다 없으면 `quiet` 항목 자체를 지운다 */
function dropQuiet(c: { quiet?: QuietConfig }, which: 'snooze' | 'schedule'): void {
  if (!c.quiet) return;
  delete c.quiet[which];
  if (c.quiet.snooze === undefined && c.quiet.schedule === undefined) delete c.quiet;
}
