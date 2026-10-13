import { BlertError } from '../shared/errors.js';
import { RUN_LOCK_STALE_MS } from '../shared/defaults.js';
import { LANGUAGES, osLocale, parseLanguage, resolveLanguage, setLanguage, t, type Language } from '../i18n/index.js';
import { suggest } from './suggest.js';
import type { Command, Ctx } from './types.js';

/** 언어 이름은 그 언어로 표기한다 (어느 언어로 안내 중이어도 알아볼 수 있게) */
const nameOf = (l: Language): string => t(`lang.name.${l}`);

/**
 * `blert lang [ko|en]` (FR-I18N-01, D-124). 인자가 없으면 현재 언어와 정해진 방법을 보여 주고,
 * 있으면 설정에 저장한 뒤 바로 그 언어로 안내한다. 실행 중인 감시는 시작할 때의 언어를 유지한다 (D-125).
 */
export const langCommand: Command = {
  name: 'lang',
  usageKeys: ['usage.lang'],
  allowedOptions: [],
  async run({ rest, deps }: Ctx) {
    const { io, store } = deps;
    if (rest.length > 1) throw new BlertError('err.langUsage');

    if (rest.length === 0) {
      const { language, source } = resolveLanguage({ env: process.env.BLERT_LANG, config: (await store.loadConfig()).language, locale: osLocale() });
      io.out(t('lang.current', { name: nameOf(language), code: language, source: t(`lang.source.${source}`) }));
      io.out(t('lang.choices'));
      return 0;
    }

    const raw = rest[0]!;
    const chosen = LANGUAGES.find((l) => l === raw.toLowerCase());
    if (!chosen) {
      const s = suggest(raw, LANGUAGES);
      throw new BlertError('err.langUnknown', { value: raw, suggestion: s ?? '' });
    }
    await store.updateConfig((c) => {
      c.language = chosen;
    });
    setLanguage(chosen); // 이 명령의 나머지 안내부터 새 언어로 보여 준다
    io.out(t('lang.done', { name: nameOf(chosen) }));

    const envLang = process.env.BLERT_LANG;
    if (parseLanguage(envLang) && parseLanguage(envLang) !== chosen) io.out(t('lang.envOverride', { env: envLang! }));
    // 실행 중인 감시(백그라운드 또는 포그라운드)는 시작할 때의 언어를 계속 쓴다 (D-125)
    if ((await store.inspectRunLock(deps.daemon.now(), RUN_LOCK_STALE_MS)).state === 'running') io.out(t('lang.restart'));
    return 0;
  },
};
