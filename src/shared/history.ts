import type { Alert, SoundKind } from './types.js';

/**
 * 알림 기록 (v1.5, FR-HIST-01, D-142~D-146). 문장이 아니라 `titleKey`와 `params`를 저장해 읽을 때 현재 언어로 만든다.
 * 키·시크릿은 담지 않는다. 알림의 값(심볼·가격·수량 등)만 담긴다.
 */
export const HISTORY_SCHEMA_VERSION = 1;
/** 최신 이만큼만 남긴다 (D-144) */
export const HISTORY_MAX_ENTRIES = 2000;
/** 이보다 오래된 것은 지운다 (D-144) */
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 한 번에 여러 건이 오면 이 시간 동안 모아서 한 번에 쓴다 (D-143) */
export const HISTORY_FLUSH_MS = 1000;

/** 조용히 처리된 알림의 표시: `sound`는 소리·음성만, `all`은 화면·채널까지 껐다는 뜻 */
export type QuietMark = 'sound' | 'all';

export interface HistoryEntry {
  /** 발동 시각 (ISO 8601) */
  ts: string;
  ruleId: number;
  kind: SoundKind;
  titleKey: string;
  params: Record<string, string | number>;
  quiet?: QuietMark;
}

export interface HistoryFile {
  schemaVersion: number;
  entries: HistoryEntry[];
}

export const toHistoryEntry = (a: Alert, quiet?: QuietMark): HistoryEntry => ({
  ts: a.firedAt,
  ruleId: a.ruleId,
  kind: a.kind,
  titleKey: a.titleKey,
  params: { ...a.params },
  ...(quiet ? { quiet } : {}),
});

const KINDS: readonly string[] = ['up', 'down', 'account', 'warn'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 파일에서 읽은 항목을 의심하고 받아들인다. 형식이 맞지 않는 항목은 버린다 (손상된 한 건이 전체를 막지 않게) */
export function parseHistoryEntry(v: unknown): HistoryEntry | undefined {
  if (!isObj(v)) return undefined;
  if (typeof v.ts !== 'string' || !Number.isFinite(Date.parse(v.ts))) return undefined;
  if (typeof v.ruleId !== 'number' || !Number.isInteger(v.ruleId)) return undefined;
  if (typeof v.kind !== 'string' || !KINDS.includes(v.kind)) return undefined;
  if (typeof v.titleKey !== 'string' || v.titleKey === '' || v.titleKey.length > 200) return undefined;
  if (!isObj(v.params)) return undefined;
  const params: Record<string, string | number> = {};
  for (const [k, val] of Object.entries(v.params)) {
    if (typeof val === 'string' || (typeof val === 'number' && Number.isFinite(val))) params[k] = val;
  }
  const quiet = v.quiet === 'sound' || v.quiet === 'all' ? v.quiet : undefined;
  return { ts: v.ts, ruleId: v.ruleId, kind: v.kind as SoundKind, titleKey: v.titleKey, params, ...(quiet ? { quiet } : {}) };
}

/** 시각 순(오래된 것 먼저)으로 정렬한다. 같은 시각이면 들어온 순서를 유지한다. 여러 경로(묶음 지연, warn 즉시 전송)로 들어와 순서가 어긋날 수 있다 */
export const sortHistory = (entries: HistoryEntry[]): HistoryEntry[] => entries.map((e, i) => ({ e, i, t: Date.parse(e.ts) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.e);

/** 오래된 것부터 지운다: 30일이 지난 것과, 최신 2,000건을 넘는 것 (D-144). 입력은 오래된 순이어야 한다 */
export function pruneHistory(entries: HistoryEntry[], nowMs: number, o: { maxEntries?: number; maxAgeMs?: number } = {}): HistoryEntry[] {
  const maxAge = o.maxAgeMs ?? HISTORY_MAX_AGE_MS;
  const max = o.maxEntries ?? HISTORY_MAX_ENTRIES;
  const fresh = entries.filter((e) => nowMs - Date.parse(e.ts) <= maxAge);
  return fresh.length > max ? fresh.slice(fresh.length - max) : fresh;
}
