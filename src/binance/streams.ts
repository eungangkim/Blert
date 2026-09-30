import type { BlertEvent } from '../shared/events.js';
import type { Market } from '../shared/types.js';
import { iso } from '../shared/clock.js';

export type StreamKind = 'ticker' | 'kline' | 'funding';

/** 스트림 이름은 소문자 심볼 + 종류 (문서: 심볼은 소문자). 펀딩비는 mark price 스트림(3초)에 들어 있다. */
export function streamName(kind: StreamKind, symbol: string): string {
  const s = symbol.toLowerCase();
  return kind === 'ticker' ? `${s}@miniTicker` : kind === 'kline' ? `${s}@kline_1m` : `${s}@markPrice`;
}

const num = (v: unknown): number => (typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN);

interface Payload {
  s?: unknown;
  c?: unknown;
  q?: unknown;
  r?: unknown;
  T?: unknown;
  k?: { t?: unknown; c?: unknown; q?: unknown; x?: unknown };
}

/**
 * 결합 스트림 메시지의 data를 내부 이벤트로 바꾼다. 형식이 다르면 null (조용히 버리지 않고 호출자가 센다).
 * ts는 수신 시각(주입된 시계)이다. 서버 시각을 쓰지 않는 이유는 절전 감지·쿨다운을 같은 시계로 다루기 위함이다.
 */
export function parseStreamMessage(market: Market, stream: string, data: unknown, nowMs: number): BlertEvent | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Payload;
  const symbol = typeof d.s === 'string' ? d.s.toUpperCase() : stream.split('@')[0]?.toUpperCase();
  if (!symbol) return null;
  const ts = iso(nowMs);

  if (stream.endsWith('@miniTicker')) {
    const price = num(d.c);
    const quoteVolume = num(d.q);
    if (!Number.isFinite(price) || !Number.isFinite(quoteVolume)) return null;
    return { type: 'market.ticker', ts, market, symbol, price, quoteVolume };
  }
  if (stream.endsWith('@kline_1m')) {
    const k = d.k;
    const openTime = num(k?.t);
    const close = num(k?.c);
    const quoteVolume = num(k?.q);
    if (!k || !Number.isFinite(openTime) || !Number.isFinite(close) || !Number.isFinite(quoteVolume)) return null;
    return { type: 'market.kline', ts, market, symbol, openTime: iso(openTime), close, quoteVolume, closed: k.x === true };
  }
  if (stream.endsWith('@markPrice')) {
    const rate = num(d.r);
    const next = num(d.T);
    if (!Number.isFinite(rate) || !Number.isFinite(next)) return null;
    return { type: 'market.funding', ts, symbol, rate, nextFundingTime: iso(next) };
  }
  return null;
}
