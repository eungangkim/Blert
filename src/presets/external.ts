import { DEFAULT_REPEAT } from '../shared/defaults.js';
import { ASSET_NAME, HYSTERESIS_MAX_PCT, LIQ_MAX_PCT_EXCLUSIVE, MULTIPLE_MIN_EXCLUSIVE, SYMBOL_BODY, inDurationRange, isFullSymbol, validLiqStages } from '../shared/limits.js';
import type { Condition, Market, RepeatPolicy, Rule, RuleType, SoundKind } from '../shared/types.js';

/** 외부 프리셋 파일의 한도 (D-101, D-102) */
export const EXTERNAL_PRESET_LIMITS = { maxRules: 50, maxBytes: 256 * 1024, name: 40, description: 200, license: 100, author: 100 } as const;
export const EXTERNAL_PRESET_SCHEMA_VERSION = 1;
/** 슬러그: 영문 소문자·숫자·하이픈 (D-80) */
export const SLUG_FORMAT = /^[a-z0-9-]{3,40}$/;
/** 터미널 제어 문자(ANSI 이스케이프 포함). 화면을 속이는 문자열을 막는다 (D-101) */
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

export interface ExternalRule {
  type: RuleType;
  market: Market;
  symbol: string;
  condition: Condition;
  repeat: RepeatPolicy;
  sound?: SoundKind | 'off';
  name?: string;
}
export interface ExternalPreset {
  slug: string;
  version: number;
  name: string;
  description?: string;
  license: string;
  author?: string;
  rules: ExternalRule[];
}

export type ExternalProblem =
  | { kind: 'json' }
  | { kind: 'schema'; version: string }
  | { kind: 'slug'; value: string }
  /** 필수 항목이 없거나 형식·범위가 틀림. field는 `rules[2].condition.pct`처럼 위치 */
  | { kind: 'field'; field: string };

type Result<T> = { ok: true; value: T } | { ok: false; problem: ExternalProblem };
const bad = (field: string): { ok: false; problem: ExternalProblem } => ({ ok: false, problem: { kind: 'field', field } });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max && !CONTROL.test(v);

const RULE_TYPES: readonly RuleType[] = ['price', 'change', 'volume', 'funding', 'fill', 'balance', 'liq'];
const SOUNDS: readonly string[] = ['up', 'down', 'account', 'warn', 'off'];

function parseRepeat(v: unknown, type: RuleType, at: string): Result<RepeatPolicy> {
  // 체결·잔고 알림은 반복 정책이 정해져 있다 (`add --mode`와 같은 규칙)
  if (v === undefined) return { ok: true, value: DEFAULT_REPEAT[type] };
  if (type === 'fill' || type === 'balance') return bad(at);
  if (!isObj(v)) return bad(at);
  if (v.kind === 'once') return { ok: true, value: { kind: 'once' } };
  if (v.kind === 'cooldown') return num(v.ms) && Number.isInteger(v.ms) && inDurationRange(v.ms) ? { ok: true, value: { kind: 'cooldown', ms: v.ms } } : bad(`${at}.ms`);
  if (v.kind === 'hysteresis') return num(v.widthPct) && v.widthPct > 0 && v.widthPct <= HYSTERESIS_MAX_PCT ? { ok: true, value: { kind: 'hysteresis', widthPct: v.widthPct } } : bad(`${at}.widthPct`);
  return bad(`${at}.kind`);
}

/** 규칙의 시장·심볼·조건이 유형에 맞는지 `blert add`와 같은 기준으로 검사한다 */
function parseCondition(type: RuleType, market: Market, symbol: string, c: Record<string, unknown>, at: string): Result<Condition> {
  const dur = (v: unknown): v is number => num(v) && Number.isInteger(v) && inDurationRange(v);
  switch (type) {
    case 'price':
      if (!isFullSymbol(symbol)) return bad(`${at.replace('.condition', '')}.symbol`);
      if (c.direction !== 'above' && c.direction !== 'below') return bad(`${at}.direction`);
      if (!num(c.price) || !(c.price > 0)) return bad(`${at}.price`);
      return { ok: true, value: { type, direction: c.direction, price: c.price } };
    case 'change':
      if (!isFullSymbol(symbol)) return bad(`${at.replace('.condition', '')}.symbol`);
      if (!num(c.pct) || !(c.pct > 0)) return bad(`${at}.pct`);
      if (!dur(c.windowMs)) return bad(`${at}.windowMs`);
      if (c.direction !== 'up' && c.direction !== 'down' && c.direction !== 'both') return bad(`${at}.direction`);
      return { ok: true, value: { type, pct: c.pct, windowMs: c.windowMs, direction: c.direction } };
    case 'volume':
      if (!isFullSymbol(symbol)) return bad(`${at.replace('.condition', '')}.symbol`);
      if (!num(c.multiple) || !(c.multiple > MULTIPLE_MIN_EXCLUSIVE)) return bad(`${at}.multiple`);
      if (!dur(c.shortMs)) return bad(`${at}.shortMs`);
      if (!dur(c.longMs) || c.shortMs >= c.longMs) return bad(`${at}.longMs`);
      return { ok: true, value: { type, multiple: c.multiple, shortMs: c.shortMs, longMs: c.longMs } };
    case 'funding':
      if (market !== 'futures') return bad(`${at.replace('.condition', '')}.market`);
      if (!isFullSymbol(symbol)) return bad(`${at.replace('.condition', '')}.symbol`);
      if (c.direction !== 'above' && c.direction !== 'below') return bad(`${at}.direction`);
      if (!num(c.pct)) return bad(`${at}.pct`);
      return { ok: true, value: { type, direction: c.direction, pct: c.pct } };
    case 'liq':
      if (market !== 'futures') return bad(`${at.replace('.condition', '')}.market`);
      if (!isFullSymbol(symbol)) return bad(`${at.replace('.condition', '')}.symbol`);
      if (!num(c.pct) || !(c.pct > 0) || c.pct >= LIQ_MAX_PCT_EXCLUSIVE) return bad(`${at}.pct`);
      if (c.stages !== undefined) {
        // 단계별 청산 경고 (D-118, D-121): 2~4개 내림차순이고 첫 값은 pct와 같다
        if (!Array.isArray(c.stages) || !c.stages.every(num) || !validLiqStages(c.stages) || c.stages[0] !== c.pct) return bad(`${at}.stages`);
        return { ok: true, value: { type, pct: c.pct, stages: [...c.stages] } };
      }
      return { ok: true, value: { type, pct: c.pct } };
    case 'fill': {
      const base = at.replace('.condition', '');
      // 현물은 심볼 또는 전체('*'), 선물은 심볼을 지정해야 한다 (D-52)
      if (!(symbol === '*' ? market === 'spot' : isFullSymbol(symbol))) return bad(`${base}.symbol`);
      return { ok: true, value: { type } };
    }
    case 'balance': {
      const base = at.replace('.condition', '');
      if (market !== 'spot') return bad(`${base}.market`);
      if (symbol !== '*') return bad(`${base}.symbol`);
      if (typeof c.asset !== 'string' || (c.asset !== '*' && !ASSET_NAME.test(c.asset))) return bad(`${at}.asset`);
      if (!num(c.pct) || !(c.pct > 0)) return bad(`${at}.pct`);
      return { ok: true, value: { type, asset: c.asset, pct: c.pct } };
    }
  }
}

function parseRule(v: unknown, i: number): Result<ExternalRule> {
  const at = `rules[${i}]`;
  if (!isObj(v)) return bad(at);
  if (typeof v.type !== 'string' || !RULE_TYPES.includes(v.type as RuleType)) return bad(`${at}.type`);
  const type = v.type as RuleType;
  if (v.market !== 'spot' && v.market !== 'futures') return bad(`${at}.market`);
  const market: Market = v.market;
  if (typeof v.symbol !== 'string' || (v.symbol !== '*' && !SYMBOL_BODY.test(v.symbol))) return bad(`${at}.symbol`);
  if (!isObj(v.condition) || v.condition.type !== type) return bad(`${at}.condition.type`);

  const cond = parseCondition(type, market, v.symbol, v.condition, `${at}.condition`);
  if (!cond.ok) return cond;
  const repeat = parseRepeat(v.repeat, type, `${at}.repeat`);
  if (!repeat.ok) return repeat;
  // 단계별 청산 경고는 쿨다운 반복만 쓴다 (D-119, `blert add`와 같은 규칙)
  if (cond.value.type === 'liq' && cond.value.stages && v.repeat !== undefined && repeat.value.kind !== 'cooldown') return bad(`${at}.repeat.kind`);
  if (v.sound !== undefined && (typeof v.sound !== 'string' || !SOUNDS.includes(v.sound))) return bad(`${at}.sound`);
  if (v.name !== undefined && !str(v.name, EXTERNAL_PRESET_LIMITS.name)) return bad(`${at}.name`);

  return {
    ok: true,
    value: {
      type,
      market,
      symbol: v.symbol,
      condition: cond.value,
      repeat: repeat.value,
      ...(v.sound !== undefined ? { sound: v.sound as SoundKind | 'off' } : {}),
      ...(v.name !== undefined ? { name: v.name as string } : {}),
    },
  };
}

/**
 * 외부 프리셋 파일을 검사한다 (D-79, D-101~D-104). 하나라도 틀리면 전체를 거부한다.
 * 모르는 항목은 무시하고 결과에 담지 않는다. 규칙의 출처(source)는 파일이 주장해도 읽지 않는다.
 */
export function parseExternalPreset(text: string): Result<ExternalPreset> {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return { ok: false, problem: { kind: 'json' } };
  }
  if (!isObj(d)) return { ok: false, problem: { kind: 'json' } };
  if (d.schemaVersion !== EXTERNAL_PRESET_SCHEMA_VERSION) return { ok: false, problem: { kind: 'schema', version: String(d.schemaVersion ?? '') } };
  if (typeof d.slug !== 'string' || !SLUG_FORMAT.test(d.slug)) return { ok: false, problem: { kind: 'slug', value: typeof d.slug === 'string' ? d.slug.slice(0, 60).replace(CONTROL, '?') : '' } };
  if (!num(d.version) || !Number.isInteger(d.version) || d.version < 1 || d.version > 9999) return bad('version');
  if (!str(d.name, EXTERNAL_PRESET_LIMITS.name)) return bad('name');
  if (d.description !== undefined && !str(d.description, EXTERNAL_PRESET_LIMITS.description)) return bad('description');
  if (!str(d.license, EXTERNAL_PRESET_LIMITS.license)) return bad('license');
  if (d.author !== undefined && !str(d.author, EXTERNAL_PRESET_LIMITS.author)) return bad('author');
  if (!Array.isArray(d.rules) || d.rules.length < 1 || d.rules.length > EXTERNAL_PRESET_LIMITS.maxRules) return bad('rules');

  const rules: ExternalRule[] = [];
  for (const [i, r] of d.rules.entries()) {
    const parsed = parseRule(r, i);
    if (!parsed.ok) return parsed;
    rules.push(parsed.value);
  }
  return {
    ok: true,
    value: {
      slug: d.slug,
      version: d.version,
      name: d.name,
      ...(d.description !== undefined ? { description: d.description as string } : {}),
      license: d.license,
      ...(d.author !== undefined ? { author: d.author as string } : {}),
      rules,
    },
  };
}

/** 규칙 개수를 유형별로 센다 (설치 전 요약용) */
export function countByType(rules: { type: Rule['type'] }[]): Partial<Record<Rule['type'], number>> {
  const out: Partial<Record<Rule['type'], number>> = {};
  for (const r of rules) out[r.type] = (out[r.type] ?? 0) + 1;
  return out;
}

/** 계정 규칙(체결·잔고·청산가)은 API 키가 있어야 동작한다 (D-103) */
export const needsKey = (r: { type: Rule['type'] }): boolean => r.type === 'fill' || r.type === 'balance' || r.type === 'liq';
