import { allowedHosts, isAllowedUrl, type NetworkMode } from '../shared/network.js';
import type { Credentials } from './credentials.js';

/** 읽기 전용 키로 인정하는 '켜져 있어도 되는' 항목. 이 밖의 어떤 권한이든 켜져 있으면 거부한다 (결정 3A: 화이트리스트, 실패 시 거부). */
export const ALLOWED_ENABLED = new Set(['enableReading', 'enableFixReadOnly', 'ipRestrict']);

/** 출금 권한. 이 밖에 켜진 권한은 거래 계열로 안내한다 (마진, 선물, 옵션, 이체, FIX 거래 등) */
const WITHDRAW_FIELDS = new Set(['enableWithdrawals']);

/**
 * 바이낸스가 '이 키로는 안 된다'고 답한 경우. 다시 시도해도 같다.
 * -2008 존재하지 않는 API 키(실서버 응답 확인: "Invalid Api-Key ID."), -2014 API 키 형식 오류,
 * -2015 키·허용 IP·권한 문제, -1022 서명 불일치(키쌍이 다름), 401/403 인증 실패.
 * 시계 오차(-1021), 요청 한도(429/418), 서버 오류는 일시적일 수 있어 여기에 넣지 않는다.
 */
export function isKeyRejection(status: number | undefined, code: number | undefined): boolean {
  return code === -2008 || code === -2014 || code === -2015 || code === -1022 || status === 401 || status === 403;
}

export interface Denial {
  /** withdraw: 출금, trade: 거래·마진·선물·이체 등 그 밖의 쓰기 권한, noRead: 읽기 권한 없음 */
  code: 'withdraw' | 'trade' | 'noRead';
  /** 문제가 된 권한 이름 (바이낸스 응답의 필드명) */
  fields: string[];
}

export type RestrictionsResult =
  | { kind: 'ok'; ipRestricted: boolean }
  | { kind: 'denied'; denied: Denial[] }
  /** 키·서명·허용 IP가 거부됨 (재시도해도 소용없음) */
  | { kind: 'rejected'; detail: string }
  /** 네트워크·서버·요청 한도·시계 오차 등 일시적일 수 있는 실패 */
  | { kind: 'unreachable'; detail: string };

/**
 * GET /sapi/v1/account/apiRestrictions 응답을 판정한다 (순수 함수).
 * 응답 형식이 예상과 다르면 안전하게 거부하지 않고 '확인 실패'로 돌려준다(키를 쓰게 두지도 않는다).
 */
export function evaluateRestrictions(body: unknown): RestrictionsResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { kind: 'unreachable', detail: 'unexpected response shape' };
  const r = body as Record<string, unknown>;
  if (typeof r.enableReading !== 'boolean') return { kind: 'unreachable', detail: 'unexpected response shape' };

  const denied: Denial[] = [];
  // 이름순으로 정렬해 안내 문구가 바이낸스 응답의 필드 순서에 흔들리지 않게 한다
  const enabled = Object.entries(r).filter(([name, v]) => v === true && !ALLOWED_ENABLED.has(name)).map(([name]) => name).sort();
  const withdraw = enabled.filter((n) => WITHDRAW_FIELDS.has(n));
  const trade = enabled.filter((n) => !WITHDRAW_FIELDS.has(n));
  if (withdraw.length) denied.push({ code: 'withdraw', fields: withdraw });
  if (trade.length) denied.push({ code: 'trade', fields: trade });
  if (r.enableReading !== true) denied.push({ code: 'noRead', fields: ['enableReading'] });

  return denied.length ? { kind: 'denied', denied } : { kind: 'ok', ipRestricted: r.ipRestrict === true };
}

export interface FetchRestrictionsOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  /** 실서버 REST 주소. 테스트넷은 /sapi를 지원하지 않아 호출하지 않는다. */
  base?: string;
  mode?: NetworkMode;
  timeoutMs?: number;
}

const REST_BASE = 'https://api.binance.com';
const RECV_WINDOW = 5000;

/**
 * 키 권한 조회. 문서: https://developers.binance.com/docs/wallet/account/api-key-permission
 * 서명 방식: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/request-security
 * (쿼리 문자열을 Ed25519로 서명 → base64 → 퍼센트 인코딩해 signature를 마지막에 붙인다)
 * 요청·오류 메시지에 키 값은 담지 않는다.
 */
export async function fetchRestrictions(creds: Credentials, o: FetchRestrictionsOptions = {}): Promise<RestrictionsResult> {
  const fetchFn = o.fetchFn ?? fetch;
  const base = o.base ?? REST_BASE;
  const query = `recvWindow=${RECV_WINDOW}&timestamp=${(o.now ?? Date.now)()}`;
  const url = `${base}/sapi/v1/account/apiRestrictions?${query}&signature=${encodeURIComponent(creds.sign(query))}`;
  if (!isAllowedUrl(url, allowedHosts(o.mode ?? 'mainnet'))) return { kind: 'unreachable', detail: 'blocked request to a non-Binance host' };

  let res: Response;
  try {
    res = await fetchFn(url, { headers: { 'X-MBX-APIKEY': creds.apiKey }, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
  } catch (e) {
    return { kind: 'unreachable', detail: e instanceof Error ? e.name : 'network error' };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'unreachable', detail: `HTTP ${res.status}` };
  }

  if (res.ok) return evaluateRestrictions(body);

  const code = typeof (body as { code?: unknown })?.code === 'number' ? (body as { code: number }).code : undefined;
  const msg = typeof (body as { msg?: unknown })?.msg === 'string' ? (body as { msg: string }).msg : '';
  const detail = `HTTP ${res.status}${code !== undefined ? ` code ${code}` : ''}${msg ? ` ${msg}` : ''}`.slice(0, 200);
  if (isKeyRejection(res.status, code)) return { kind: 'rejected', detail };
  return { kind: 'unreachable', detail }; // -1021(시계 오차), 429/418(요청 한도), 5xx 등
}
