import type { Alert, SoundKind } from '../shared/types.js';
import type { Logger } from '../shared/logger.js';
import { isAllowedUrl } from '../shared/network.js';
import type { NotifyAdapter, SendContext } from './adapters.js';
import { render, summarizeAlerts } from './render.js';

const LOG = 'notify.telegram';
/** 텔레그램 봇 API. 문서: https://core.telegram.org/bots/api (호출 형식 https://api.telegram.org/bot<token>/METHOD_NAME) */
export const TELEGRAM_BASE = 'https://api.telegram.org';
/** 외부 채널 도메인은 채널을 등록했을 때만 쓴다 (D-69). 바이낸스 허용 목록(shared/network)과 따로 둔다. */
export const TELEGRAM_HOSTS: readonly string[] = ['api.telegram.org'];

/** D-73: 알림당 1회 시도 + 재시도 2회. 429는 응답의 대기 시간만큼(상한 30초) */
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000];
const MAX_RETRY_AFTER_S = 30;
const SUMMARY_MIN = 3;

export type TgFailure = 'blocked' | 'network' | 'unauthorized' | 'bad-request' | 'rate-limited' | 'server' | 'http';
export type TgResult<T> = { ok: true; value: T } | { ok: false; reason: TgFailure; status?: number };

export interface TelegramClientOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** 테스트에서만 바꾼다. 허용 도메인 검사는 항상 한다 (NFR-SEC-02) */
  base?: string;
  hosts?: readonly string[];
  logger?: Logger;
  timeoutMs?: number;
}

export interface TelegramChat {
  chatId: string;
  name: string;
}

interface ApiBody {
  ok?: boolean;
  result?: unknown;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/**
 * 텔레그램 봇 API 호출. 토큰은 URL 경로에 들어가므로 URL·오류 문구를 로그에 남기지 않는다 (NFR-SEC-01).
 * 채널 키체인 접근은 하지 않는다: 토큰은 호출하는 쪽이 넘긴다.
 */
export class TelegramClient {
  constructor(private o: TelegramClientOptions = {}) {}

  /** 메시지 한 건 전송. 재시도 정책은 D-73. 설정 오류(400·401·403·404)는 재시도하지 않는다. */
  async sendMessage(token: string, chatId: string, text: string): Promise<TgResult<void>> {
    let last: TgResult<void> = { ok: false, reason: 'network' };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await this.call<unknown>(token, 'sendMessage', { chat_id: chatId, text });
      if (r.ok) return { ok: true, value: undefined };
      last = r;
      const retryable = r.reason === 'network' || r.reason === 'server' || r.reason === 'rate-limited';
      if (!retryable || attempt === MAX_ATTEMPTS - 1) break;
      const wait = r.reason === 'rate-limited' ? Math.min(this.lastRetryAfter ?? 1, MAX_RETRY_AFTER_S) * 1000 : (RETRY_DELAYS_MS[attempt] ?? 2000);
      await this.sleep(wait);
    }
    this.o.logger?.warn(LOG, `send failed: ${last.ok ? 'unknown' : last.reason}${!last.ok && last.status ? ` (HTTP ${last.status})` : ''}`);
    return last as TgResult<void>;
  }

  /** 봇이 받은 메시지에서 대화 ID를 찾는다 (`getUpdates`). 오래된 것부터 순서대로 돌려준다. */
  async listChats(token: string): Promise<TgResult<TelegramChat[]>> {
    const r = await this.call<unknown[]>(token, 'getUpdates', { limit: 100, timeout: 0 });
    if (!r.ok) return r;
    const seen = new Map<string, string>();
    for (const u of Array.isArray(r.value) ? r.value : []) {
      // 개인 대화(message)뿐 아니라 수정된 메시지, 채널 글, 그룹에 봇을 추가한 알림(my_chat_member)에서도 대화를 찾는다
      const up = u as Record<string, { chat?: { id?: unknown; first_name?: unknown; title?: unknown; username?: unknown } } | undefined> | undefined;
      const chat = (up?.message ?? up?.edited_message ?? up?.channel_post ?? up?.my_chat_member)?.chat;
      if (chat?.id === undefined || (typeof chat.id !== 'number' && typeof chat.id !== 'string')) continue;
      const name = [chat.title, chat.first_name, chat.username].find((v) => typeof v === 'string' && v) as string | undefined;
      seen.delete(String(chat.id)); // 가장 최근 메시지가 뒤로 가게 한다
      seen.set(String(chat.id), name ?? String(chat.id));
    }
    return { ok: true, value: [...seen].map(([chatId, name]) => ({ chatId, name })) };
  }

  // ---- 내부 ----

  private lastRetryAfter?: number;

  private sleep(ms: number): Promise<void> {
    return (this.o.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
  }

  private async call<T>(token: string, method: string, body: Record<string, unknown>): Promise<TgResult<T>> {
    const url = `${this.o.base ?? TELEGRAM_BASE}/bot${token}/${method}`;
    if (!isAllowedUrl(url, this.o.hosts ?? TELEGRAM_HOSTS)) {
      this.o.logger?.error(LOG, 'blocked request to a non-allowed host');
      return { ok: false, reason: 'blocked' };
    }
    let res: Response;
    try {
      res = await (this.o.fetchFn ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
    } catch (e) {
      this.o.logger?.warn(LOG, `${method} request failed: ${e instanceof Error ? e.name : 'error'}`); // URL(토큰 포함)은 남기지 않는다
      return { ok: false, reason: 'network' };
    }
    let data: ApiBody | undefined;
    try {
      data = (await res.json()) as ApiBody;
    } catch {
      data = undefined;
    }
    if (res.ok && data?.ok === true) return { ok: true, value: data.result as T };
    const status = res.status;
    if (status === 429) {
      this.lastRetryAfter = typeof data?.parameters?.retry_after === 'number' ? data.parameters.retry_after : undefined;
      return { ok: false, reason: 'rate-limited', status };
    }
    if (status === 401 || status === 403 || status === 404) return { ok: false, reason: 'unauthorized', status };
    if (status === 400) return { ok: false, reason: 'bad-request', status };
    if (status >= 500) return { ok: false, reason: 'server', status };
    return { ok: false, reason: 'http', status };
  }
}

/** 채널 등록 정보와 토큰을 보내는 순간에 읽는다 (`channel add/remove`가 실행 중인 데몬에도 바로 반영되도록) */
export interface ChannelSource {
  load(): Promise<{ chatId: string; includeAccount: boolean } | undefined>;
  token(): Promise<string | undefined>;
}

type Group = 'public' | 'warning' | 'account' | 'never';

/**
 * 채널로 보낼 수 있는 알림 종류 (D-69, D-72). 모르는 종류는 보내지 않는다(새 알림이 실수로 새어 나가지 않게).
 * - public: 공개 시장 알림 / warning: 감시 중단·연결 경고 → 채널이 켜져 있으면 항상
 * - account: 체결·잔고·청산가·키 관련 → 계정 알림 포함을 켠 경우에만
 * - never: 감시 시작, 시험 알림 등
 */
export function classifyAlert(titleKey: string): Group {
  if (/^alert\.(price|change|volume|funding)\./.test(titleKey)) return 'public';
  if (/^alert\.(gap|conn|partial|recovered)\./.test(titleKey)) return 'warning';
  if (/^alert\.(fill|balance|liq|key|account)\./.test(titleKey)) return 'account';
  return 'never';
}

const ICON: Record<SoundKind, string> = { up: '▲', down: '▼', account: '●', warn: '!' };

export function formatMessage(a: Alert): string {
  const { title, body } = render(a);
  return `${ICON[a.kind]} ${title}${body ? `\n${body}` : ''}`;
}

/** 텔레그램 어댑터 (FR-NOTI-03, B7). 채널을 등록하지 않았으면 아무 요청도 하지 않는다 (AC-61). */
export class TelegramAdapter implements NotifyAdapter {
  readonly name = 'telegram';
  /** 묶음 요약 전의 전체 알림을 받아 계정 알림을 걸러낸 뒤 직접 묶는다 */
  readonly wantsAll = true;

  constructor(
    private source: ChannelSource,
    private client: TelegramClient,
  ) {}

  async send(alerts: Alert[], ctx?: SendContext): Promise<void> {
    const cfg = await this.source.load();
    if (!cfg) return;
    const eligible = alerts.filter((a) => {
      const g = classifyAlert(a.titleKey);
      return g === 'public' || g === 'warning' || (g === 'account' && cfg.includeAccount);
    });
    if (eligible.length === 0) return;
    const token = await this.source.token();
    if (!token) throw new Error('channel token is missing from the keychain');
    const messages = ctx?.summarized && eligible.length >= SUMMARY_MIN ? [summarizeAlerts(eligible)] : eligible;
    for (const m of messages) {
      const r = await this.client.sendMessage(token, cfg.chatId, formatMessage(m));
      if (!r.ok) throw new Error(`telegram ${r.reason}${r.status ? ` ${r.status}` : ''}`); // 실패하면 남은 알림도 포기한다 (D-73)
    }
  }
}
