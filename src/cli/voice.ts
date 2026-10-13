import { BlertError } from '../shared/errors.js';
import { platformGroup } from '../shared/platform.js';
import { SOUND_KINDS } from '../shared/theme.js';
import type { SoundKind } from '../shared/types.js';
import { t } from '../i18n/index.js';
import { suggest } from './suggest.js';
import type { Command, Ctx, Deps } from './types.js';

const SUBS = ['on', 'off', 'kinds', 'list', 'use', 'test'] as const;
/** 기본으로 읽는 알림 종류 (D-112) */
const DEFAULT_KINDS: readonly SoundKind[] = ['warn', 'account'];

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const guide = (): string => t(`notify.guide.voice.${platformGroup()}`);

/** `up,down` 같은 쉼표 목록을 종류 배열로. 비었거나 모르는 종류가 있으면 오류 (D-112) */
function parseKinds(raw: string): SoundKind[] {
  const parts = raw.split(',').map((p) => p.trim().toLowerCase());
  if (parts.length === 0 || parts.some((p) => !SOUND_KINDS.includes(p as SoundKind))) throw new BlertError('err.voiceKinds', { value: raw });
  return SOUND_KINDS.filter((k) => parts.includes(k)); // 중복을 없애고 정해진 순서로
}

async function currentVoice(deps: Deps): Promise<{ enabled: boolean; kinds: SoundKind[]; voiceName?: string }> {
  const v = (await deps.store.loadConfig()).voice;
  return { enabled: v?.enabled ?? false, kinds: v?.kinds?.length ? v.kinds : [...DEFAULT_KINDS], ...(v?.voiceName ? { voiceName: v.voiceName } : {}) };
}

/** 음성 알림 (FR-NOTI-05, D-110~D-117). 음성 설정은 알림을 읽을 때마다 읽으므로 실행 중인 감시도 바로 따른다 (D-117) */
export const voiceCommand: Command = {
  name: 'voice',
  usageKeys: ['usage.voice.onoff', 'usage.voice.kinds', 'usage.voice.list', 'usage.voice.use', 'usage.voice.test'],
  allowedOptions: [],
  async run({ rest, deps }: Ctx) {
    const [subRaw, ...args] = rest;
    const sub = SUBS.find((s) => s === subRaw?.toLowerCase());
    if (!sub) {
      const s = subRaw ? suggest(subRaw, SUBS) : undefined;
      throw new BlertError(s ? 'err.voiceSub' : 'err.voiceUsage', { value: subRaw ?? '', suggestion: s ?? '' });
    }
    const { io, store, voice } = deps;

    if (sub === 'on' || sub === 'off') {
      if (args.length > 0) throw new BlertError('err.voiceUsage');
      const cur = await currentVoice(deps);
      await store.updateConfig((c) => {
        c.voice = { ...cur, enabled: sub === 'on' };
      });
      if (sub === 'off') {
        io.out(t('voice.off.done'));
        return 0;
      }
      io.out(t('voice.on.done', { kinds: cur.kinds.join(', ') }));
      // 켜기는 적용하되, 이 PC에서 음성을 확인하지 못하면 바로 알려 준다
      await voice.list().catch((e: unknown) => io.out(t('voice.on.noEngine', { reason: reason(e), guide: guide() })));
      return 0;
    }

    if (sub === 'kinds') {
      if (args.length !== 1) throw new BlertError('err.voiceKinds', { value: args.join(' ') });
      const kinds = parseKinds(args[0]!);
      const cur = await currentVoice(deps);
      await store.updateConfig((c) => {
        c.voice = { ...cur, kinds };
      });
      io.out(t('voice.kinds.done', { kinds: kinds.join(', ') }));
      return 0;
    }

    if (sub === 'list') {
      if (args.length > 0) throw new BlertError('err.voiceUsage');
      const cur = await currentVoice(deps);
      io.out(t(cur.enabled ? 'voice.list.on' : 'voice.list.off', { kinds: cur.kinds.join(', ') }));
      io.out(cur.voiceName ? t('voice.list.selected', { name: cur.voiceName }) : t('voice.list.default'));
      const voices = await voice.list().catch((e: unknown) => {
        throw new BlertError('err.voiceNone', { reason: reason(e), guide: guide() });
      });
      if (voices.length === 0) io.out(t('voice.list.none'));
      for (const v of voices) io.out(t('voice.list.row', { mark: v.name === cur.voiceName ? '*' : ' ', name: v.name, culture: v.culture ? ` (${v.culture})` : '' }));
      return 0;
    }

    if (sub === 'use') {
      // 공백이 든 음성 이름(Microsoft Heami Desktop)을 따옴표 없이 써도 되게 나머지를 이어 붙인다
      const name = args.join(' ').trim();
      if (!name) throw new BlertError('err.voiceUsage');
      if (name.toLowerCase() === 'default') {
        const cur = await currentVoice(deps);
        await store.updateConfig((c) => {
          c.voice = { enabled: cur.enabled, kinds: cur.kinds };
        });
        io.out(t('voice.use.default'));
        return 0;
      }
      const voices = await voice.list().catch((e: unknown) => {
        throw new BlertError('err.voiceNone', { reason: reason(e), guide: guide() });
      });
      const hit = voices.find((v) => v.name.toLowerCase() === name.toLowerCase());
      if (!hit) throw new BlertError('err.voiceUnknown', { value: name, names: voices.map((v) => v.name).join(', ') || '-', example: voices[0]?.name ?? 'default' });
      const cur = await currentVoice(deps);
      await store.updateConfig((c) => {
        c.voice = { ...cur, voiceName: hit.name };
      });
      io.out(t('voice.use.done', { name: hit.name }));
      return 0;
    }

    // test: 설정(켬/끔)과 무관하게 선택한 음성으로 시험 문장을 읽는다
    if (args.length > 0) throw new BlertError('err.voiceUsage');
    const cur = await currentVoice(deps);
    io.out(t('voice.test.speaking'));
    try {
      await voice.speak(t('speech.voiceTest'), cur.voiceName);
    } catch (e) {
      throw new BlertError('err.voiceTest', { reason: reason(e), guide: guide() });
    }
    return 0;
  },
};
