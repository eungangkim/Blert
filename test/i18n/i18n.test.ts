import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { t, hasMessage } from '../../src/i18n/index.js';
import ko from '../../src/i18n/ko.json' with { type: 'json' };

const SRC = join(import.meta.dirname, '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'i18n' ? [] : sourceFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('i18n', () => {
  it('자리표시자를 채우고, 없는 값은 그대로 둔다', () => {
    expect(t('store.ruleNotFound', { id: 7 })).toContain('ID 7');
    expect(t('store.schemaTooNew', { file: 'a.json' })).toContain('{found}');
  });

  it('없는 키는 키 이름을 돌려준다', () => {
    expect(hasMessage('nope.key')).toBe(false);
    expect(t('nope.key')).toBe('nope.key');
  });

  it('NFR-UX-03 오류 메시지는 해결 방법과 예시를 담는다', () => {
    for (const [key, text] of Object.entries(ko)) {
      if (!/(error|Timeout|TooNew|corrupt|NotFound|invalid)/i.test(key)) continue;
      expect(text, key).toMatch(/예:/);
    }
  });

  it('AC-24 소스 코드(i18n 제외)의 주석 밖에 한글 문장이 없다', () => {
    const offenders = sourceFiles(SRC).filter((f) => /[가-힣]/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
