import { BlertError, ExitCode } from '../shared/errors.js';
import { t } from '../i18n/index.js';
import { askYesNo } from './init.js';
import type { Command, Ctx, Io } from './types.js';

/** `channel add`가 사용자가 봇에 메시지를 보내기를 기다리는 시간과 확인 간격 (D-71) */
export const CHAT_WAIT_MS = 60_000;
const CHAT_POLL_MS = 2_000;
const TOKEN_FORMAT = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/;
const CHAT_ID_FORMAT = /^-?\d{1,20}$/;
const SUBS = ['add', 'remove', 'test', 'account'] as const;

async function askLine(io: Io, question: string): Promise<string> {
  const line = await io.ask(question);
  if (line === null) throw new BlertError('err.noInput');
  return line.trim();
}

/**
 * `blert channel add|remove|test telegram` (FR-NOTI-03, D-69~D-73).
 * 비밀은 명령행 인자로 받지 않는다. 토큰은 프롬프트로 받아 OS 키체인에만 저장하고, 시험 메시지가 성공한 뒤에만 저장한다.
 */
export const channelCommand: Command = {
  name: 'channel',
  usageKeys: ['usage.channel.add', 'usage.channel.remove', 'usage.channel.test', 'usage.channel.account'],
  allowedOptions: [],
  async run({ rest, deps }: Ctx) {
    const [subRaw, typeRaw, ...extra] = rest;
    const sub = SUBS.find((s) => s === subRaw?.toLowerCase());
    if (!sub || extra.length > 0) {
      throw new BlertError('err.usage', { usage: t(`usage.channel.${sub ?? 'add'}`), example: t(sub === 'account' ? 'example.channelAccount' : 'example.channel') });
    }
    const { io, store, channel } = deps;
    const registered = async () => (await store.loadConfig()).channels?.find((c) => c.type === 'telegram');

    // 등록한 채널은 그대로 두고 계정 알림 포함 여부만 바꾼다 (D-71)
    if (sub === 'account') {
      const want = typeRaw?.toLowerCase();
      if ((want !== 'on' && want !== 'off') || extra.length > 0) throw new BlertError('err.usage', { usage: t('usage.channel.account'), example: t('example.channelAccount') });
      const cfg = await registered();
      if (!cfg) throw new BlertError('err.channelNoneAccount');
      const on = want === 'on';
      if (on && !cfg.includeAccount && !(await askYesNo(io, t('channel.accountAsk'), false))) {
        io.out(t('channel.accountUnchanged')); // 켜기는 계정 정보가 외부 서버를 거치므로 동의를 다시 받는다 (D-69)
        return 0;
      }
      await store.updateConfig((c) => {
        const ch = c.channels?.find((x) => x.type === 'telegram');
        if (ch) ch.includeAccount = on; // 토큰과 대화 ID는 건드리지 않는다
      });
      io.out(t(on ? 'channel.accountOn' : 'channel.accountOff'));
      return 0;
    }

    if (typeRaw !== undefined && typeRaw.toLowerCase() !== 'telegram') throw new BlertError('err.channelType', { value: typeRaw });
    if (sub === 'add' && typeRaw === undefined) throw new BlertError('err.usage', { usage: t('usage.channel.add'), example: t('example.channel') });

    if (sub === 'remove') {
      const had = (await registered()) !== undefined;
      const removed = await channel.removeToken();
      await store.updateConfig((c) => {
        delete c.channels;
      });
      io.out(t(had || removed ? 'channel.removed' : 'channel.none'));
      return 0;
    }

    if (sub === 'test') {
      if (!(await registered()) || !(await channel.hasToken())) throw new BlertError('err.channelNone');
      const cfg = (await registered())!;
      const r = await channel.send(cfg.chatId, t('channel.testMessage'));
      if (!r.ok) throw new BlertError('err.channelSendFailed', { reason: r.reason });
      io.out(t('channel.testSent'));
      return 0;
    }

    // add: 고지와 동의 → 키체인 확인 → 토큰 → 대화 찾기 → 계정 알림 포함 여부 → 시험 메시지 → 저장
    for (const k of ['channel.disclosure1', 'channel.disclosure2', 'channel.disclosure3', 'channel.disclosure4']) io.out(t(k));
    if (!(await askYesNo(io, t('channel.askAgree'), false))) throw new BlertError('err.channelDeclined');
    if (!(await channel.keychainAvailable())) throw new BlertError('err.channelNoKeychain');

    const token = await askLine(io, t('channel.promptToken'));
    if (!TOKEN_FORMAT.test(token)) throw new BlertError('err.channelToken');

    const chatId = await findChat(deps, token);
    const includeAccount = await askYesNo(io, t('channel.askAccount'), false);

    io.out(t('channel.sendingTest'));
    const sent = await channel.send(chatId, t('channel.testMessage'), token);
    if (!sent.ok) throw new BlertError('err.channelSendFailed', { reason: sent.reason });

    const replacing = (await registered()) !== undefined;
    await channel.saveToken(token);
    await store.updateConfig((c) => {
      c.channels = [{ type: 'telegram', chatId, includeAccount }];
    });
    if (replacing) io.out(t('channel.replaced'));
    io.out(t(includeAccount ? 'channel.addedAccountOn' : 'channel.addedAccountOff'));
    return 0;
  },
};

/** 대화 ID 직접 입력의 최대 시도 횟수 */
const MAX_CHAT_ID_TRIES = 3;

/** 봇에 보낸 메시지에서 대화를 찾는다. 시간 안에 못 찾으면 undefined (D-71) */
async function waitForChat(deps: Ctx['deps'], token: string): Promise<{ chatId: string; name: string } | undefined> {
  const { io, channel, daemon } = deps;
  io.out(t('channel.waitMessage', { seconds: CHAT_WAIT_MS / 1000 }));
  const deadline = daemon.now() + CHAT_WAIT_MS;
  for (;;) {
    const r = await channel.listChats(token);
    if (!r.ok) {
      if (r.reason === 'rejected') throw new BlertError('err.channelTokenRejected');
      if (r.reason === 'network') throw new BlertError('err.channelNetwork', {}, ExitCode.connection);
      return undefined; // 그 밖의 응답(웹훅 설정 등)은 직접 입력으로 넘어간다
    }
    const latest = r.chats.at(-1);
    if (latest) return latest;
    if (daemon.now() >= deadline) return undefined;
    await daemon.sleep(CHAT_POLL_MS);
  }
}

/** 봇에 보낸 메시지에서 대화 ID를 찾고, 못 찾으면 직접 입력받는다 (D-71) */
async function findChat(deps: Ctx['deps'], token: string): Promise<string> {
  const { io } = deps;
  const found = await waitForChat(deps, token);
  io.drain?.(); // 기다리는 동안 터미널에 친 글자가 다음 질문의 답으로 쓰이지 않게 버린다
  if (found) {
    io.out(t('channel.chatFound', { name: found.name }));
    if (await askYesNo(io, t('channel.askUseChat'), true)) return found.chatId;
  } else {
    io.out(t('channel.noMessage'));
  }
  let last = '';
  for (let i = 0; i < MAX_CHAT_ID_TRIES; i++) {
    last = await askLine(io, t('channel.promptChatId'));
    if (CHAT_ID_FORMAT.test(last)) return last;
    if (i < MAX_CHAT_ID_TRIES - 1) io.out(t('channel.chatIdInvalid', { value: last }));
  }
  throw new BlertError('err.channelChatId', { value: last });
}
