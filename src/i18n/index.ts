import ko from './ko.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };

/** 메시지 언어 (FR-I18N-01, D-86, D-122). 문구는 언어별 JSON 파일로 코드와 분리한다 (NFR-UX-02) */
export const LANGUAGES = ['ko', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

const catalogs: Record<Language, Record<string, string>> = { ko, en };
const plurals = new Intl.PluralRules('en');

let current: Language = 'ko';

export function setLanguage(language: Language): void {
  current = language;
}

export function getLanguage(): Language {
  return current;
}

/** `ko`, `en`, `ko-KR`, `en_US.UTF-8` 같은 값을 지원하는 언어로 바꾼다. 지원하지 않으면 undefined */
export function parseLanguage(raw: unknown): Language | undefined {
  if (typeof raw !== 'string') return undefined;
  const code = raw.trim().toLowerCase().split(/[-_.@]/)[0];
  return LANGUAGES.find((l) => l === code);
}

export type LanguageSource = 'env' | 'config' | 'os' | 'default';

/**
 * 언어를 정하는 순서 (D-123): `BLERT_LANG` 환경 변수 > 설정 > OS 로캘 > `ko`.
 * OS 로캘이 한국어 계열이면 `ko`, 그 밖의 알려진 로캘이면 `en`이다. 지원하지 않는 값은 무시하고 다음 순서로 넘어간다.
 */
export function resolveLanguage(o: { env?: unknown; config?: unknown; locale?: string }): { language: Language; source: LanguageSource } {
  const fromEnv = parseLanguage(o.env);
  if (fromEnv) return { language: fromEnv, source: 'env' };
  const fromConfig = parseLanguage(o.config);
  if (fromConfig) return { language: fromConfig, source: 'config' };
  const locale = o.locale?.trim();
  if (locale && locale !== 'C' && locale !== 'POSIX') return { language: parseLanguage(locale) ?? 'en', source: 'os' };
  return { language: 'ko', source: 'default' };
}

/** OS 로캘. 환경 변수(LC_ALL > LC_MESSAGES > LANG)를 먼저 보고, 없으면 Node가 알려 주는 값을 쓴다 */
export function osLocale(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const v = env[key]?.trim();
    if (v) return v;
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/** 현재 언어의 문구, 없으면 한국어 문구(D-128), 그것도 없으면 키 이름 */
function lookup(key: string): string | undefined {
  return catalogs[current][key] ?? catalogs.ko[key];
}

/**
 * 메시지 키 → 문장. `{name}` 자리표시자를 params로 채운다 (D-14).
 * 영어는 `count`가 숫자이고 `<키>_one`이 있으면 단수·복수 규칙으로 고른다 (D-127).
 */
export function t(key: string, params: Record<string, string | number> = {}): string {
  let template: string | undefined;
  if (current === 'en' && typeof params.count === 'number') {
    const form = plurals.select(params.count);
    template = catalogs.en[`${key}_${form}`];
  }
  template ??= lookup(key);
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** 키가 있는지. 한국어 파일이 기준이다 */
export const hasMessage = (key: string): boolean => key in catalogs.ko;
