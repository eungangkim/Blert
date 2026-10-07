import { BlertError, ExitCode } from '../shared/errors.js';
import { t } from '../i18n/index.js';
import { askYesNo } from './init.js';
import type { Command, Ctx, Io } from './types.js';

/** `channel add`가 사용자가 봇에 메시지를 보내기를 기다리는 시간과 확인 간격 (D-71) */
export const CHAT_WAIT_MS = 60_000;
const CHAT_POLL_MS = 2_000;
const TOKEN_FORMAT = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/;
const CHAT_ID_FORMAT = /^-?\d{1,20}$/;
const SUBS = ['add', 'remove', 'test'] as const;

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
  usageKeys: ['usage.channel.add', 'usage.channel.remove', 'usage.channel.test'],
  allowedOptions: [],
  async run({ rest, deps }: Ctx) {
    const [subRaw, typeRaw, ...extra] = rest;
    const sub = SUBS.find((s) => s === subRaw?.toLowerCase());
    if (!sub || extra.length > 0) throw new BlertError('err.usage', { usage: t('usage.channel.add'), example: t('example.channel') });
    if (typeRaw !== undefined && typeRaw.toLowerCase() !== 'telegram') throw new BlertError('err.channelType', { value: typeRaw });
    if (sub === 'add' && typeRaw === undefined) throw new BlertError('err.usage', { usage: t('usage.channel.add'), example: t('example.channel') });
    const { io, store, channel } = deps;

    const registered = async () => (await store.loadConfig()).channels?.find((c) => c.type === 'telegram');

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

/** 봇에 보낸 메시지에서 대화 ID를 찾고, 못 찾으면 직접 입력받는다 (D-71) */
async function findChat(deps: Ctx['deps'], token: string): Promise<string> {
  const { io, channel, daemon } = deps;
  io.out(t('channel.waitMessage', { seconds: CHAT_WAIT_MS / 1000 }));
  const deadline = daemon.now() + CHAT_WAIT_MS;
  for (;;) {
    const r = await channel.listChats(token);
    if (!r.ok) {
      if (r.reason === 'rejected') throw new BlertError('err.channelTokenRejected');
      if (r.reason === 'network') throw new BlertError('err.channelNetwork', {}, ExitCode.connection);
      break; // 그 밖의 응답(웹훅 설정 등)은 직접 입력으로 넘어간다
    }
    const latest = r.chats.at(-1);
    if (latest) {
      io.out(t('channel.chatFound', { name: latest.name }));
      if (await askYesNo(io, t('channel.askUseChat'), true)) return latest.chatId;
      break;
    }
    if (daemon.now() >= deadline) {
      io.out(t('channel.noMessage'));
      break;
    }
    await daemon.sleep(CHAT_POLL_MS);
  }
  const manual = await askLine(io, t('channel.promptChatId'));
  if (!CHAT_ID_FORMAT.test(manual)) throw new BlertError('err.channelChatId', { value: manual });
  return manual;
}
