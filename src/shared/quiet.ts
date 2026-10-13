import type { SoundKind } from './types.js';

/**
 * 조용한 시간 판정 (v1.5, FR-NOTI-06, D-135~D-141). 순수 함수만 둔다. 시각은 호출하는 쪽이 주입한 시계(ms)로 받고
 * OS 현지 시각으로 읽는다(D-138). 설정 파일이 손상돼도 판정이 죽지 않도록 값을 모두 의심하고 읽는다.
 */
export const SNOOZE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** 조용히 할 범위 (D-136, D-137) */
export interface QuietScope {
  /** true면 화면 알림·외부 채널까지 끈다. false면 소리·음성만 끈다 */
  all: boolean;
  /** true면 warn 종류도 조용히 한다. false면 warn은 조용한 시간에도 울린다 */
  includeWarn: boolean;
}
export interface QuietSchedule extends QuietScope {
  /** `HH:MM` (현지 시각). 시작을 포함하고 끝은 포함하지 않는다 */
  from: string;
  to: string;
}
export interface QuietSnooze extends QuietScope {
  /** 끝나는 시각 (ISO 8601) */
  until: string;
}
/** `config.json`의 `quiet` (D-140) */
export interface QuietConfig {
  schedule?: QuietSchedule;
  snooze?: QuietSnooze;
}

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM`을 하루 중 몇 분째인지로 바꾼다. 형식이 틀리면 undefined */
export function parseHm(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined;
  const m = HM.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

/** 지금이 하루 중 몇 분째인지 (OS 현지 시각, 초는 버린다) */
export function minuteOfDay(nowMs: number): number {
  const d = new Date(nowMs);
  return d.getHours() * 60 + d.getMinutes();
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const scopeOf = (v: { all?: unknown; includeWarn?: unknown }): QuietScope => ({ all: v.all === true, includeWarn: v.includeWarn === true });

/** 매일 반복 구간 안인가. 자정을 넘기는 구간을 허용하고 시작과 끝이 같으면 구간이 없는 것으로 본다 (D-138) */
export function scheduleActive(s: unknown, nowMs: number): s is QuietSchedule {
  if (!isObj(s)) return false;
  const from = parseHm(s.from);
  const to = parseHm(s.to);
  if (from === undefined || to === undefined || from === to) return false;
  const now = minuteOfDay(nowMs);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** 잠깐 쉬기가 아직 끝나지 않았는가 */
export function snoozeActive(s: unknown, nowMs: number): s is QuietSnooze {
  if (!isObj(s) || typeof s.until !== 'string') return false;
  const until = Date.parse(s.until);
  return Number.isFinite(until) && until > nowMs;
}

/**
 * 지금 조용히 해야 하는지와 그 범위. 둘이 겹치면 더 많이 끄는 쪽을 따른다(D-135).
 * 조용한 시간이 아니면 undefined.
 */
export function activeQuiet(q: unknown, nowMs: number): QuietScope | undefined {
  if (!isObj(q)) return undefined;
  const on: QuietScope[] = [];
  if (scheduleActive(q.schedule, nowMs)) on.push(scopeOf(q.schedule));
  if (snoozeActive(q.snooze, nowMs)) on.push(scopeOf(q.snooze));
  if (on.length === 0) return undefined;
  return { all: on.some((s) => s.all), includeWarn: on.some((s) => s.includeWarn) };
}

/** 이 종류의 알림을 조용히 해야 하는가. warn은 includeWarn일 때만 (D-137) */
export const isMuted = (scope: QuietScope | undefined, kind: SoundKind): boolean => scope !== undefined && (kind !== 'warn' || scope.includeWarn);
