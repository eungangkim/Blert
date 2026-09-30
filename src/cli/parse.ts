import { BlertError } from '../shared/errors.js';
import type { Market, RepeatPolicy } from '../shared/types.js';
import { COOLDOWN_MAX_MS, COOLDOWN_MIN_MS } from '../shared/defaults.js';
import { STABLE_QUOTES } from '../shared/symbol.js';
import { suggest } from './suggest.js';


/** 스테이블 견적으로 끝나면 전체 심볼, 아니면 뒤에 USDT를 붙인다 (D-21) */
export function parseSymbol(raw: string): { market: Market; symbol: string } {
  const futures = /^f:/i.test(raw);
  const body = (futures ? raw.slice(2) : raw).toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(body)) throw new BlertError('err.symbol', { value: raw });
  const full = STABLE_QUOTES.some((q) => body.endsWith(q) && body.length > q.length);
  return { market: futures ? 'futures' : 'spot', symbol: full ? body : `${body}USDT` };
}

export function parsePrice(raw: string): number {
  const n = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!(n > 0)) throw new BlertError('err.price', { value: raw });
  return n;
}

export function parsePercent(raw: string, allowNegative = false): number {
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(raw);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(n) || (!allowNegative && n <= 0)) throw new BlertError('err.percent', { value: raw });
  return n;
}

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function parseDuration(raw: string): number {
  const m = /^(\d+)([smhd])$/.exec(raw);
  const ms = m ? Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS] : 0;
  if (!(ms > 0)) throw new BlertError('err.duration', { value: raw });
  return ms;
}

/** 변동률·거래량 구간 범위: 1분 ~ 24시간 (히스토리 메모리와 백필 한도) */
export function parseWindow(raw: string): number {
  const ms = parseDuration(raw);
  if (ms < COOLDOWN_MIN_MS || ms > COOLDOWN_MAX_MS) throw new BlertError('err.windowRange', { value: raw });
  return ms;
}

export function parseMultiple(raw: string): number {
  const m = /^x(\d+(?:\.\d+)?)$/i.exec(raw);
  const n = m ? Number(m[1]) : NaN;
  if (!(n > 1)) throw new BlertError('err.multiple', { value: raw });
  return n;
}

export function parseDirection<T extends string>(raw: string, allowed: readonly T[]): T {
  const hit = allowed.find((a) => a === raw.toLowerCase());
  if (hit) return hit;
  const s = suggest(raw, allowed);
  const list = allowed.join(', ');
  throw s
    ? new BlertError('err.directionDidYouMean', { value: raw, allowed: list, suggestion: s })
    : new BlertError('err.direction', { value: raw, allowed: list });
}

/** --mode once | cooldown:<시간> | hyst:<퍼센트> (FR-REP-03) */
export function parseMode(raw: string): RepeatPolicy {
  if (raw === 'once') return { kind: 'once' };
  const cd = /^cooldown:(.+)$/.exec(raw);
  if (cd) {
    const ms = parseDuration(cd[1]!);
    if (ms < COOLDOWN_MIN_MS || ms > COOLDOWN_MAX_MS) throw new BlertError('err.modeRange', { value: raw });
    return { kind: 'cooldown', ms };
  }
  const hy = /^hyst:(.+)$/.exec(raw);
  if (hy) {
    const widthPct = parsePercent(hy[1]!);
    if (widthPct > 100) throw new BlertError('err.modeHyst', { value: raw });
    return { kind: 'hysteresis', widthPct };
  }
  throw new BlertError('err.mode', { value: raw });
}
