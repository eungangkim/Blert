import { describe, expect, it, vi } from 'vitest';
import { Notifier } from '../../src/notify/index.js';
import { MAX_WAITING, VoiceAdapter, VoiceEngine, type VoiceConfig } from '../../src/notify/voice.js';
import { SPEECH_MAX_CHARS, sanitizeSpeech, speechText } from '../../src/notify/speech.js';
import type { NotifyAdapter } from '../../src/notify/adapters.js';
import type { Alert, SoundKind } from '../../src/shared/types.js';

const alert = (kind: SoundKind, titleKey: string, params: Alert['params'] = {}, extra: Partial<Alert> = {}): Alert => ({
  ruleId: 1,
  kind,
  titleKey,
  params,
  firedAt: '2026-10-13T00:00:00.000Z',
  ...extra,
});
const liqAlert = (extra: Partial<Alert> = {}) => alert('warn', 'alert.liq.title', { coin: 'BTC', quote: 'USDT', distance: '3.6%', side: 'LONG' }, extra);
const priceAlert = (extra: Partial<Alert> = {}) => alert('up', 'alert.price.above.title', { coin: 'BTC', quote: 'USDT', target: '84,500' }, extra);
const fillAlert = () => alert('account', 'alert.fill.title', { coin: 'ETH', quote: 'USDT', side: 'BUY' });

function setup(initial: VoiceConfig | undefined = { enabled: true, kinds: ['warn', 'account'] }) {
  const spoken: { text: string; voiceName?: string }[] = [];
  const state = { cfg: initial as VoiceConfig | undefined, fail: undefined as ((voiceName?: string) => boolean) | undefined };
  const warnings: string[] = [];
  const engine = {
    speak: async (text: string, voiceName?: string) => {
      if (state.fail?.(voiceName)) throw new Error('speak failed');
      spoken.push({ text, ...(voiceName ? { voiceName } : {}) });
    },
  };
  const adapter = new VoiceAdapter({ engine, config: async () => state.cfg, warn: (t) => warnings.push(t) });
  return { adapter, spoken, state, warnings };
}

describe('음성 문장 (D-113)', () => {
  it('AC-96 화면 제목이 아니라 짧은 전용 문장을 읽는다', () => {
    expect(speechText(liqAlert())).toBe('BTC 선물 청산가까지 3.6%');
    expect(speechText(priceAlert())).toBe('BTC 84,500 돌파');
    expect(speechText(fillAlert())).toBe('ETH 매수 체결');
    expect(speechText(alert('warn', 'alert.liq.stage.title', { coin: 'BTC', distance: '1.5%', side: 'LONG', stage: 3, stages: 3, level: 'urgent' }))).toBe('BTC 선물 청산 긴급 3단계, 청산가까지 1.5%');
    expect(speechText(alert('up', 'alert.batch.title', { count: 5, list: 'a\nb\nc' }))).toBe('알림 5건'); // 묶음 요약은 개수만
  });

  it('AC-96 전용 문장이 없는 알림은 화면 제목을 읽는다', () => {
    expect(speechText(alert('warn', 'alert.key.trade.title'))).toBe('계정 알림 중단 — 거래 권한이 켜진 키');
  });

  it('AC-97 제어 문자를 지우고 공백을 정리하며 100자로 자른다', () => {
    const esc = String.fromCharCode(27);
    expect(sanitizeSpeech(`a${esc}[31m\nb c\td`)).toBe('a [31m b c d');
    expect(sanitizeSpeech('가'.repeat(300))).toHaveLength(SPEECH_MAX_CHARS);
    expect(speechText(alert('warn', 'alert.liq.title', { coin: `BTC${esc}]0;x\n`, distance: '1%' }))).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('VoiceAdapter (FR-NOTI-05)', () => {
  it('AC-96 기본 종류(warn, account)만 읽고 up은 읽지 않는다. kinds에 넣으면 읽는다', async () => {
    const { adapter, spoken, state } = setup();
    await adapter.send([priceAlert()]);
    await adapter.send([liqAlert()]);
    await adapter.send([fillAlert()]);
    expect(spoken.map((s) => s.text)).toEqual(['BTC 선물 청산가까지 3.6%', 'ETH 매수 체결']);
    state.cfg = { enabled: true, kinds: ['up', 'down', 'account', 'warn'] };
    await adapter.send([priceAlert()]);
    expect(spoken.at(-1)!.text).toBe('BTC 84,500 돌파');
  });

  it('AC-96 규칙의 --sound 지정을 따른다 (off는 읽지 않고, 다른 종류는 그 종류로 판단)', async () => {
    const { adapter, spoken } = setup();
    await adapter.send([liqAlert({ sound: 'off' })]);
    expect(spoken).toEqual([]);
    await adapter.send([priceAlert({ sound: 'warn' })]); // up 알림이지만 소리 지정이 warn
    expect(spoken).toHaveLength(1);
    await adapter.send([liqAlert({ sound: 'up' })]); // warn 알림이지만 소리 지정이 up → 기본 종류가 아님
    expect(spoken).toHaveLength(1);
  });

  it('AC-96 묶음에는 읽을 종류가 하나라도 있으면 그 알림을 읽는다', async () => {
    const { adapter, spoken } = setup();
    await adapter.send([priceAlert(), liqAlert()]);
    expect(spoken.map((s) => s.text)).toEqual(['BTC 선물 청산가까지 3.6%']);
  });

  it('AC-95 꺼져 있거나 설정이 없으면 읽지 않는다', async () => {
    const { adapter, spoken, state } = setup({ enabled: false, kinds: ['warn'] });
    await adapter.send([liqAlert()]);
    state.cfg = undefined;
    await adapter.send([liqAlert()]);
    expect(spoken).toEqual([]);
  });

  it('AC-100 설정을 읽을 때마다 새로 읽어 재시작 없이 켜기·끄기·음성 선택이 바로 바뀐다', async () => {
    const { adapter, spoken, state } = setup({ enabled: false, kinds: ['warn'] });
    await adapter.send([liqAlert()]);
    state.cfg = { enabled: true, kinds: ['warn'], voiceName: 'Voice Ko' };
    await adapter.send([liqAlert()]);
    state.cfg = { enabled: true, kinds: ['warn'] };
    await adapter.send([liqAlert()]);
    state.cfg = { enabled: false, kinds: ['warn'] };
    await adapter.send([liqAlert()]);
    expect(spoken).toEqual([{ text: 'BTC 선물 청산가까지 3.6%', voiceName: 'Voice Ko' }, { text: 'BTC 선물 청산가까지 3.6%' }]);
  });

  it('AC-98 한 번에 하나씩 말하고, 대기가 2건을 넘으면 오래된 것을 버린다', async () => {
    const releases: (() => void)[] = [];
    const spoken: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const engine = {
      speak: (text: string) =>
        new Promise<void>((resolve) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          spoken.push(text);
          releases.push(() => {
            concurrent--;
            resolve();
          });
        }),
    };
    const adapter = new VoiceAdapter({ engine, config: async () => ({ enabled: true, kinds: ['warn'] }) });
    const mk = (n: number) => liqAlert({ params: { coin: `C${n}`, distance: '1%' } });
    const sends = [1, 2, 3, 4, 5].map((n) => adapter.send([mk(n)]));
    await vi.waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken).toEqual(['C1 선물 청산가까지 1%']); // 첫 건만 재생 중, 나머지는 대기
    releases.shift()!();
    await vi.waitFor(() => expect(spoken).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(spoken).toHaveLength(3));
    releases.shift()!();
    await Promise.all(sends); // 버려진 것도 포함해 모두 끝난다
    expect(spoken.map((s) => s.slice(0, 2))).toEqual(['C1', 'C4', 'C5']); // 2, 3은 버려짐 (대기 최대 2건)
    expect(maxConcurrent).toBe(1);
    expect(MAX_WAITING).toBe(2);
  });

  it('AC-99 선택한 음성이 없으면 기본 음성으로 대신하고 안내는 한 번만 한다', async () => {
    const { adapter, spoken, state, warnings } = setup({ enabled: true, kinds: ['warn'], voiceName: 'Gone Voice' });
    state.fail = (v) => v === 'Gone Voice';
    await adapter.send([liqAlert()]);
    await adapter.send([liqAlert()]);
    expect(spoken).toEqual([{ text: 'BTC 선물 청산가까지 3.6%' }, { text: 'BTC 선물 청산가까지 3.6%' }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Gone Voice');
    expect(warnings[0]).toContain('blert voice list');
  });

  it('AC-99 기본 음성도 쓸 수 없으면 오류를 던지고, Notifier는 알림·소리를 유지하며 안내를 한 번만 한다', async () => {
    const { adapter, state } = setup();
    state.fail = () => true;
    const played: string[] = [];
    const sound: NotifyAdapter = { name: 'sound', send: async () => void played.push('sound') };
    const warnings: string[] = [];
    const notifier = new Notifier({ adapters: [sound, adapter], warn: (t) => warnings.push(t), platform: 'win32', holdMs: 0 });
    notifier.announce(liqAlert());
    notifier.announce(liqAlert());
    await notifier.flush();
    expect(played).toEqual(['sound', 'sound']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('음성');
    expect(warnings[0]).toContain('blert voice test');
  });

  it('AC-98 소리가 끝난 뒤에 말한다 (after: sound)', async () => {
    const { adapter } = setup();
    const log: string[] = [];
    let endSound!: () => void;
    const sound: NotifyAdapter = {
      name: 'sound',
      send: () =>
        new Promise<void>((resolve) => {
          log.push('sound:start');
          endSound = () => {
            log.push('sound:end');
            resolve();
          };
        }),
    };
    const wrapped: NotifyAdapter = {
      name: 'voice',
      after: adapter.after,
      send: async (alerts) => {
        log.push('voice:start');
        await adapter.send(alerts);
      },
    };
    const notifier = new Notifier({ adapters: [sound, wrapped], warn: () => {}, holdMs: 0 });
    notifier.announce(liqAlert());
    await vi.waitFor(() => expect(log).toEqual(['sound:start']));
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual(['sound:start']); // 소리가 끝나기 전에는 음성이 시작하지 않는다
    endSound();
    await notifier.flush();
    expect(log).toEqual(['sound:start', 'sound:end', 'voice:start']);
  });

  it('AC-98 소리가 실패해도 음성은 이어서 말한다', async () => {
    const { adapter, spoken } = setup();
    const sound: NotifyAdapter = { name: 'sound', send: async () => Promise.reject(new Error('no audio device')) };
    const notifier = new Notifier({ adapters: [sound, adapter], warn: () => {}, holdMs: 0 });
    notifier.announce(liqAlert());
    await notifier.flush();
    expect(spoken).toHaveLength(1);
  });
});

describe('VoiceEngine 명령 (D-111, D-117)', () => {
  const sentence = `BTC "quoted" $(rm -rf /); \`x\` & | > 가나다`;

  it.each(['win32', 'darwin', 'linux'] as const)('AC-97 %s: 명령줄은 고정 문자열이고 문장·음성 이름은 환경 변수로만 전달한다', async (platform) => {
    const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
    const engine = new VoiceEngine({ platform, run: async (cmd, args, env) => void calls.push({ cmd, args, env }) });
    await engine.speak(sentence, 'Some Voice');
    await engine.speak('다른 문장');
    expect(calls).toHaveLength(2);
    // 문장이 달라도 명령과 인자는 같다
    expect(calls[0]!.cmd).toBe(calls[1]!.cmd);
    expect(calls[0]!.args).toEqual(calls[1]!.args);
    expect(JSON.stringify(calls[0]!.args)).not.toContain('quoted');
    expect(JSON.stringify(calls[0]!.args)).not.toContain('Some Voice');
    expect(calls[0]!.env).toEqual({ BLERT_SPEECH: sentence, BLERT_VOICE: 'Some Voice' });
    expect(calls[1]!.env).toEqual({ BLERT_SPEECH: '다른 문장', BLERT_VOICE: '' });
    if (platform === 'win32') {
      expect(calls[0]!.cmd).toBe('powershell.exe');
      expect(calls[0]!.args.at(-1)).toContain('System.Speech');
    } else {
      expect(calls[0]!.cmd).toBe('/bin/sh');
      expect(calls[0]!.args.at(-1)).toContain('"$BLERT_SPEECH"');
    }
  });

  it('AC-97 환경 변수로 넘기는 문장에서도 제어 문자는 지운다', async () => {
    let env: Record<string, string> | undefined;
    const engine = new VoiceEngine({ platform: 'win32', run: async (_c, _a, e) => void (env = e) });
    await engine.speak('a\u001b[31mb\nc');
    expect(env!.BLERT_SPEECH).toBe('a [31mb c');
  });

  it('AC-101 Windows: 설치된 음성 목록을 이름|문화권 줄에서 읽는다', async () => {
    const engine = new VoiceEngine({ platform: 'win32', capture: async () => 'Microsoft Heami Desktop|ko-KR\r\nMicrosoft Zira Desktop|en-US\r\n\r\n' });
    expect(await engine.list()).toEqual([
      { name: 'Microsoft Heami Desktop', culture: 'ko-KR' },
      { name: 'Microsoft Zira Desktop', culture: 'en-US' },
    ]);
  });

  it('AC-101 macOS: say -v ? 출력에서 이름과 언어를 읽는다', async () => {
    const out = 'Alex                en_US    # Most people recognize me by my voice.\nYuna                ko_KR    # 안녕하세요.\n';
    const engine = new VoiceEngine({ platform: 'darwin', capture: async () => out });
    expect(await engine.list()).toEqual([
      { name: 'Alex', culture: 'en-US' },
      { name: 'Yuna', culture: 'ko-KR' },
    ]);
  });
});
