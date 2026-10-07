import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramAdapter, TelegramClient, classifyAlert, createNotifier, formatMessage, type ChannelSource } from '../../src/notify/index.js';
import { Logger, mask } from '../../src/shared/logger.js';
import { iso } from '../../src/shared/clock.js';
import type { Alert } from '../../src/shared/types.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const CHAT = '777';
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const price = (extra: Partial<Alert> = {}): Alert => ({
  ruleId: 1, kind: 'up', titleKey: 'alert.price.above.title',
  params: { coin: 'BTC', quote: 'USDT', market: 'spot', target: '70,000', price: '70,012' }, firedAt: iso(Date.now()), ...extra,
});
const fill = (): Alert => ({ ruleId: 2, kind: 'account', titleKey: 'alert.fill.title', params: { coin: 'BTC', quote: 'USDT', side: 'BUY', qty: '0.01', price: '70,000' }, firedAt: iso(Date.now()) });
const liq = (): Alert => ({ ruleId: 3, kind: 'warn', titleKey: 'alert.liq.title', params: { coin: 'BTC', quote: 'USDT', side: 'LONG', distance: '3.0%', mark: '83,000', liq: '80,000', threshold: '5%' }, firedAt: iso(Date.now()) });
const gap = (): Alert => ({ ruleId: 0, kind: 'warn', titleKey: 'alert.gap.title', params: { from: '10:00', to: '10:01' }, firedAt: iso(Date.now()) });
const start = (): Alert => ({ ruleId: 0, kind: 'account', sound: 'off', titleKey: 'alert.start.title', params: { total: 1, spot: 1, futures: 0 }, firedAt: iso(Date.now()) });

interface Call {
  url: string;
  body: { chat_id?: string; text?: string };
}

function fakeTelegram(handler?: (call: Call, n: number) => Response | Error) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), body: JSON.parse(String(init?.body ?? '{}')) } as Call;
    calls.push(call);
    const r = handler?.(call, calls.length) ?? new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    if (r instanceof Error) throw r;
    return r;
  });
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function setup(opts: { cfg?: { chatId: string; includeAccount: boolean } | undefined; token?: string | undefined; handler?: Parameters<typeof fakeTelegram>[0] } = {}) {
  const net = fakeTelegram(opts.handler);
  const logs: string[] = [];
  const logger = new Logger({ write: (l) => logs.push(l) }, 'debug');
  const state = { cfg: 'cfg' in opts ? opts.cfg : { chatId: CHAT, includeAccount: false }, token: 'token' in opts ? opts.token : TOKEN };
  const source: ChannelSource = { load: async () => state.cfg, token: async () => state.token };
  const sleeps: number[] = [];
  const client = new TelegramClient({ fetchFn: net.fetchFn, sleep: async (ms) => void sleeps.push(ms), logger });
  const adapter = new TelegramAdapter(source, client);
  return { net, logs, logger, state, source, client, adapter, sleeps };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('notify 텔레그램 클라이언트 (D-70, D-73)', () => {
  it('AC-64 sendMessage는 https://api.telegram.org/bot<토큰>/sendMessage로 chat_id와 text를 JSON POST한다', async () => {
    const { net, client } = setup();
    const r = await client.sendMessage(TOKEN, CHAT, '안녕');
    expect(r.ok).toBe(true);
    expect(net.calls).toEqual([{ url: `https://api.telegram.org/bot${TOKEN}/sendMessage`, body: { chat_id: CHAT, text: '안녕' } }]);
    expect(net.fetchFn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'POST', headers: { 'content-type': 'application/json' } }));
  });

  it('AC-66 서버 오류·네트워크 오류는 재시도 2회(1초, 2초 간격)까지 하고, 성공하면 거기서 멈춘다', async () => {
    const a = setup({ handler: (_c, n) => (n < 3 ? json(502, { ok: false }) : json(200, { ok: true, result: {} })) });
    expect((await a.client.sendMessage(TOKEN, CHAT, 'x')).ok).toBe(true);
    expect(a.net.calls).toHaveLength(3);
    expect(a.sleeps).toEqual([1000, 2000]);

    const b = setup({ handler: () => new TypeError('fetch failed') });
    expect(await b.client.sendMessage(TOKEN, CHAT, 'x')).toEqual({ ok: false, reason: 'network' });
    expect(b.net.calls).toHaveLength(3);
  });

  it('AC-66 요청 한도(429)는 응답의 retry_after만큼(최대 30초) 기다렸다가 다시 보낸다', async () => {
    const a = setup({ handler: (_c, n) => (n === 1 ? json(429, { ok: false, error_code: 429, parameters: { retry_after: 5 } }) : json(200, { ok: true, result: {} })) });
    expect((await a.client.sendMessage(TOKEN, CHAT, 'x')).ok).toBe(true);
    expect(a.sleeps).toEqual([5000]);
    const b = setup({ handler: (_c, n) => (n === 1 ? json(429, { ok: false, parameters: { retry_after: 999 } }) : json(200, { ok: true, result: {} })) });
    await b.client.sendMessage(TOKEN, CHAT, 'x');
    expect(b.sleeps).toEqual([30_000]);
  });

  it('AC-66 설정 오류(400·401·403·404)는 재시도하지 않고 바로 실패로 돌려준다', async () => {
    for (const [status, reason] of [[401, 'unauthorized'], [403, 'unauthorized'], [404, 'unauthorized'], [400, 'bad-request']] as const) {
      const s = setup({ handler: () => json(status, { ok: false, error_code: status, description: 'x' }) });
      expect(await s.client.sendMessage(TOKEN, CHAT, 'x')).toEqual({ ok: false, reason, status });
      expect(s.net.calls, String(status)).toHaveLength(1);
    }
  });

  it('AC-68 허용 도메인(api.telegram.org)이 아니면 요청하지 않는다 (NFR-SEC-02)', async () => {
    const net = fakeTelegram();
    const client = new TelegramClient({ fetchFn: net.fetchFn, base: 'https://evil.example.com' });
    expect(await client.sendMessage(TOKEN, CHAT, 'x')).toEqual({ ok: false, reason: 'blocked' });
    expect(await client.listChats(TOKEN)).toEqual({ ok: false, reason: 'blocked' });
    expect(net.calls).toHaveLength(0);
  });

  it('AC-69 실패 로그에 URL(토큰)이 들어가지 않는다', async () => {
    const s = setup({ handler: () => new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`) });
    await s.client.sendMessage(TOKEN, CHAT, 'x');
    const text = s.logs.join('\n');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('123456789');
    expect(text).toContain('network');
  });

  it('listChats는 getUpdates에서 대화를 찾아 오래된 것부터 돌려주고, 같은 대화는 가장 최근 위치로 합친다', async () => {
    const updates = [
      { update_id: 1, message: { chat: { id: 111, first_name: '철수' } } },
      { update_id: 2, message: { chat: { id: -100222, title: '가족방' } } },
      { update_id: 3, message: { chat: { id: 111, first_name: '철수' } } },
      { update_id: 4, edited_message: { chat: { id: 999, first_name: '영희' } } },
      { update_id: 5, message: { chat: { id: 333, username: 'bob' } } },
      { update_id: 6, my_chat_member: { chat: { id: -100777, title: '새 그룹' } } }, // 그룹에 봇을 추가한 알림
      { update_id: 7, poll_answer: { user: { id: 1 } } }, // 대화를 알 수 없는 업데이트는 무시
    ];
    const s = setup({ handler: () => json(200, { ok: true, result: updates }) });
    const r = await s.client.listChats(TOKEN);
    expect(r).toEqual({
      ok: true,
      value: [{ chatId: '-100222', name: '가족방' }, { chatId: '111', name: '철수' }, { chatId: '999', name: '영희' }, { chatId: '333', name: 'bob' }, { chatId: '-100777', name: '새 그룹' }],
    });
    expect(s.net.calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect((await setup({ handler: () => json(200, { ok: true, result: [] }) }).client.listChats(TOKEN))).toEqual({ ok: true, value: [] });
    expect(await setup({ handler: () => json(401, { ok: false }) }).client.listChats(TOKEN)).toMatchObject({ ok: false, reason: 'unauthorized' });
  });
});

describe('notify 채널로 보낼 알림 종류 (D-69, D-72)', () => {
  it('공개 시장 알림과 감시 중단·연결 경고는 public·warning, 계정 관련은 account, 시작·시험·모르는 종류는 never', () => {
    for (const k of ['alert.price.above.title', 'alert.change.title', 'alert.volume.title', 'alert.funding.below.title']) expect(classifyAlert(k)).toBe('public');
    for (const k of ['alert.gap.title', 'alert.conn.down.title', 'alert.partial.title', 'alert.recovered.title']) expect(classifyAlert(k)).toBe('warning');
    for (const k of ['alert.fill.title', 'alert.fill.futures.title', 'alert.balance.title', 'alert.liq.title', 'alert.key.trade.title', 'alert.account.rejected.title', 'alert.account.ipwarn.title']) {
      expect(classifyAlert(k), k).toBe('account');
    }
    for (const k of ['alert.start.title', 'alert.test.title', 'alert.batch.title', 'alert.something.new.title', '']) expect(classifyAlert(k), k).toBe('never');
  });

  it('메시지는 아이콘·제목·본문으로 만든다', () => {
    expect(formatMessage(price())).toBe('▲ BTC 70,000 돌파\n현재 70,012 USDT · 현물');
  });
});

describe('notify 텔레그램 어댑터 (FR-NOTI-03, D-69~D-73)', () => {
  it('AC-61 채널을 등록하지 않았으면 어떤 알림이든 요청을 한 번도 하지 않고 토큰도 읽지 않는다', async () => {
    const s = setup({ cfg: undefined });
    const readToken = vi.spyOn(s.source, 'token');
    await s.adapter.send([price(), gap(), fill()]);
    expect(s.net.calls).toHaveLength(0);
    expect(readToken).not.toHaveBeenCalled();
  });

  it('AC-64 공개 시장 알림과 감시 중단 경고는 계정 알림 포함 여부와 상관없이 보낸다', async () => {
    const s = setup();
    await s.adapter.send([price(), gap()], { summarized: false });
    expect(s.net.calls.map((c) => c.body.text)).toEqual(['▲ BTC 70,000 돌파\n현재 70,012 USDT · 현물', '! 감시 중단 구간 있음\n10:00 ~ 10:01 동안 감시하지 못함']);
    expect(s.net.calls.every((c) => c.body.chat_id === CHAT)).toBe(true);
  });

  it('AC-65 계정 알림(체결·청산가)은 포함을 끈 채널로는 보내지 않고, 켠 채널로는 보낸다', async () => {
    const off = setup({ cfg: { chatId: CHAT, includeAccount: false } });
    await off.adapter.send([fill(), liq(), price()]);
    expect(off.net.calls).toHaveLength(1);
    expect(off.net.calls[0]!.body.text).toContain('돌파');

    const on = setup({ cfg: { chatId: CHAT, includeAccount: true } });
    await on.adapter.send([fill(), liq()]);
    expect(on.net.calls.map((c) => c.body.text!.split('\n')[0])).toEqual(['● BTC 매수 체결', '! BTC 선물 청산가까지 3.0%']);
  });

  it('AC-65 계정 알림만 있고 포함이 꺼져 있으면 토큰도 읽지 않고 요청도 없다', async () => {
    const s = setup({ cfg: { chatId: CHAT, includeAccount: false } });
    const readToken = vi.spyOn(s.source, 'token');
    await s.adapter.send([fill(), liq()]);
    expect(s.net.calls).toHaveLength(0);
    expect(readToken).not.toHaveBeenCalled();
  });

  it('감시 시작 알림과 시험 알림은 채널로 보내지 않는다', async () => {
    const s = setup({ cfg: { chatId: CHAT, includeAccount: true } });
    await s.adapter.send([start(), { ...price(), titleKey: 'alert.test.title', params: { kind: 'up' } }]);
    expect(s.net.calls).toHaveLength(0);
  });

  it('AC-64 데스크톱에 묶음 요약이 나가는 폭주(3건 이상)는 채널에도 요약 1건으로 보내되, 계정 알림은 요약에서 뺀다', async () => {
    const s = setup({ cfg: { chatId: CHAT, includeAccount: false } });
    const batch = [price(), price(), price(), fill(), fill()];
    await s.adapter.send(batch, { summarized: true });
    expect(s.net.calls).toHaveLength(1);
    expect(s.net.calls[0]!.body.text).toContain('알림 3건'); // 계정 알림 2건은 세지 않는다
    expect(s.net.calls[0]!.body.text).not.toContain('체결');

    const two = setup({ cfg: { chatId: CHAT, includeAccount: false } });
    await two.adapter.send([price(), price(), fill(), fill(), fill()], { summarized: true }); // 걸러 남은 게 2건이면 개별 전송
    expect(two.net.calls).toHaveLength(2);
  });

  it('AC-66 전송이 실패하면 오류를 던지고 남은 알림은 포기한다. 토큰이 키체인에서 사라졌어도 던진다', async () => {
    const s = setup({ handler: () => json(401, { ok: false }) });
    await expect(s.adapter.send([price(), gap()])).rejects.toThrow('telegram unauthorized 401');
    expect(s.net.calls).toHaveLength(1); // 두 번째 알림은 시도하지 않는다
    const missing = setup({ token: undefined });
    await expect(missing.adapter.send([price()])).rejects.toThrow('token is missing');
    expect(missing.net.calls).toHaveLength(0);
  });
});

describe('notify Notifier와 텔레그램 통합 (AC-64, AC-66)', () => {
  const build = (handler?: Parameters<typeof fakeTelegram>[0], cfg: { chatId: string; includeAccount: boolean } | null = { chatId: CHAT, includeAccount: false }) => {
    const net = fakeTelegram(handler);
    const desktop: string[] = [];
    const warnings: string[] = [];
    const logs: string[] = [];
    const notifier = createNotifier({
      out: (l) => warnings.push(l), console: false, soundEnabled: () => false, platform: 'linux',
      logger: new Logger({ write: (l) => logs.push(l) }, 'debug'),
      run: async (cmd, args) => void desktop.push(`${cmd} ${args.join(' ')}`),
      channel: { source: { load: async () => cfg ?? undefined, token: async () => TOKEN }, client: { fetchFn: net.fetchFn, sleep: async () => {} } },
    });
    return { notifier, net, desktop, warnings, logs };
  };

  it('AC-64 공개 알림은 데스크톱과 채널에 같은 문구로 한 번씩 나간다', async () => {
    const { notifier, net, desktop } = build();
    notifier.notify(price());
    await tick(400);
    await notifier.flush();
    expect(desktop).toHaveLength(1);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.body.text).toBe('▲ BTC 70,000 돌파\n현재 70,012 USDT · 현물');
  });

  it('AC-64 3건 이상 몰리면 채널에도 요약 1건이 간다', async () => {
    const { notifier, net, desktop } = build();
    for (let i = 0; i < 4; i++) notifier.notify(price());
    await tick(400);
    await notifier.flush();
    expect(desktop).toHaveLength(1);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.body.text).toContain('알림 4건');
  });

  it('AC-66 채널 전송이 실패해도 데스크톱 알림은 정상이고, 안내는 한 번만 보이며, 밀린 알림을 다시 보내지 않는다', async () => {
    const { notifier, net, desktop, warnings, logs } = build(() => json(500, { ok: false }));
    notifier.notify(price());
    await tick(400);
    await notifier.flush();
    notifier.notify(price());
    await tick(400);
    await notifier.flush();
    expect(desktop).toHaveLength(2); // 데스크톱은 둘 다 정상
    expect(net.calls).toHaveLength(6); // 알림당 3번 시도 후 포기, 다시 보내지 않음
    expect(warnings.filter((w) => w.includes('텔레그램 알림을 보내지 못했습니다'))).toHaveLength(1);
    expect(warnings[0]).toContain('예: blert channel test');
    expect(logs.join('\n')).toContain('telegram adapter failed');
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('AC-61 채널이 등록되지 않았으면 알림이 몇 번 나가도 채널 요청은 0건이다', async () => {
    const { notifier, net } = build(undefined, null);
    notifier.notify(price());
    notifier.announce(gap());
    await tick(400);
    await notifier.flush();
    expect(net.calls).toHaveLength(0);
  });

  it('AC-65 계정 알림은 포함을 꺼 둔 채널로 가지 않는다 (경고(warn) 종류인 청산가 알림도)', async () => {
    const { notifier, net, desktop } = build();
    notifier.notify(fill());
    notifier.notify(liq()); // warn은 즉시 개별 전송 경로
    await tick(400);
    await notifier.flush();
    expect(desktop).toHaveLength(2);
    expect(net.calls).toHaveLength(0);
  });
});

describe('로거 토큰 마스킹 (NFR-SEC-01)', () => {
  it('AC-69 텔레그램 봇 토큰은 숫자 부분까지 통째로 가린다', () => {
    expect(mask(`url https://api.telegram.org/bot${TOKEN}/sendMessage failed`)).not.toMatch(/123456789|AAHdq/);
    expect(mask(`token=${TOKEN}`)).toBe('token=***');
    expect(mask('chat 777 ok 2026-10-07')).toBe('chat 777 ok 2026-10-07'); // 일반 숫자는 그대로
  });
});
