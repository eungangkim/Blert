import ko from './ko.json' with { type: 'json' };

const messages: Record<string, string> = ko;

/** 메시지 키 → 한국어 문장. `{name}` 자리표시자를 params로 채운다 (D-14). */
export function t(key: string, params: Record<string, string | number> = {}): string {
  const template = messages[key];
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

export const hasMessage = (key: string): boolean => key in messages;
