import { afterEach, describe, expect, it } from 'vitest';
import ko from '../../src/i18n/ko.json' with { type: 'json' };
import en from '../../src/i18n/en.json' with { type: 'json' };
import { getLanguage, hasMessage, osLocale, parseLanguage, resolveLanguage, setLanguage, t } from '../../src/i18n/index.js';
import { render, summarizeAlerts } from '../../src/notify/render.js';
import { speechText } from '../../src/notify/speech.js';
import { defaultCommands } from '../../src/cli/index.js';
import { commandHelp, topHelp } from '../../src/cli/help.js';
import { describeCondition, describeRepeat } from '../../src/cli/format.js';
import type { Alert } from '../../src/shared/types.js';

afterEach(() => setLanguage('ko'));

const HANGUL = /[가-힣]/;
const koKeys = Object.keys(ko);
const enMap = en as Record<string, string>;
const koMap = ko as Record<string, string>;
/** 영어 파일에서 한글이 있어도 되는 문구: 언어 이름과 언어 선택 질문은 두 언어를 함께 보여 준다 */
const BILINGUAL = new Set(['lang.name.ko', 'init.askLanguage', 'help.cmd.lang.summary']);
const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();

describe('언어 결정 (FR-I18N-01, D-123)', () => {
  it('AC-107 ko, en, 지역·인코딩이 붙은 값도 지원 언어로 읽고 나머지는 무시한다', () => {
    for (const [raw, lang] of [['ko', 'ko'], ['EN', 'en'], ['ko-KR', 'ko'], ['en_US.UTF-8', 'en'], [' en ', 'en'], ['ko_KR.eucKR', 'ko']] as const) expect(parseLanguage(raw), raw).toBe(lang);
    for (const raw of ['fr', 'ja-JP', '', 'xx', undefined, null, 5]) expect(parseLanguage(raw), String(raw)).toBeUndefined();
  });

  it('AC-107 순서는 환경 변수 > 설정 > OS 로캘 > ko', () => {
    expect(resolveLanguage({ env: 'en', config: 'ko', locale: 'ko_KR' })).toEqual({ language: 'en', source: 'env' });
    expect(resolveLanguage({ env: undefined, config: 'en', locale: 'ko_KR' })).toEqual({ language: 'en', source: 'config' });
    expect(resolveLanguage({ config: undefined, locale: 'ko_KR.UTF-8' })).toEqual({ language: 'ko', source: 'os' });
    expect(resolveLanguage({ locale: 'en-US' })).toEqual({ language: 'en', source: 'os' });
    expect(resolveLanguage({ locale: 'ja_JP' })).toEqual({ language: 'en', source: 'os' }); // 한국어 계열이 아니면 en
    expect(resolveLanguage({})).toEqual({ language: 'ko', source: 'default' });
  });

  it('AC-107 지원하지 않는 값은 무시하고 다음 순서로 넘어간다', () => {
    expect(resolveLanguage({ env: 'fr', config: 'de', locale: 'en_GB' })).toEqual({ language: 'en', source: 'os' });
    expect(resolveLanguage({ env: 'xx', config: 'en', locale: 'ko' })).toEqual({ language: 'en', source: 'config' });
    expect(resolveLanguage({ env: '', config: 'zz' })).toEqual({ language: 'ko', source: 'default' });
  });

  it('AC-107 C·POSIX 로캘은 정보가 없는 것으로 보고 기본값(ko)을 쓴다', () => {
    expect(resolveLanguage({ locale: 'C' })).toEqual({ language: 'ko', source: 'default' });
    expect(resolveLanguage({ locale: 'POSIX' })).toEqual({ language: 'ko', source: 'default' });
  });

  it('AC-107 OS 로캘은 LC_ALL > LC_MESSAGES > LANG 순서로 읽는다', () => {
    expect(osLocale({ LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'ko_KR', LANG: 'ko_KR' })).toBe('en_US.UTF-8');
    expect(osLocale({ LC_MESSAGES: 'ko_KR', LANG: 'en_US' })).toBe('ko_KR');
    expect(osLocale({ LANG: 'en_US' })).toBe('en_US');
    expect(typeof osLocale({})).toBe('string'); // 환경 변수가 없으면 Node가 알려 주는 값
  });
});

describe('언어별 문구 파일 (D-128, NFR-UX-02)', () => {
  it('AC-109 en.json은 ko.json의 모든 키를 가진다 (단수형 _one만 영어에 더 있을 수 있다)', () => {
    expect(koKeys.filter((k) => !(k in enMap))).toEqual([]);
    const extra = Object.keys(enMap).filter((k) => !(k in koMap));
    expect(extra.filter((k) => !/_one$/.test(k) || !(k.slice(0, -4) in koMap))).toEqual([]);
  });

  it('AC-109 자리표시자가 두 언어에서 같다 (단수형은 count만 뺄 수 있다)', () => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(enMap)) {
      const isOne = k.endsWith('_one') && !(k in koMap);
      const base = koMap[isOne ? k.slice(0, -4) : k]!;
      const want = placeholders(base).filter((p) => !(isOne && p === 'count'));
      if (placeholders(v).join() !== want.join()) bad.push(`${k}: ${placeholders(v)} != ${want}`);
    }
    expect(bad).toEqual([]);
  });

  it('AC-109 en.json에는 한글이 없다 (언어 이름·언어 선택 질문 제외)', () => {
    expect(Object.entries(enMap).filter(([k, v]) => HANGUL.test(v) && !BILINGUAL.has(k)).map(([k]) => k)).toEqual([]);
  });

  it('AC-109 영어 문구가 없는 키는 한국어로 대신한다 (키 이름을 보이지 않는다)', () => {
    const saved = enMap['sound.on.done']!;
    delete enMap['sound.on.done'];
    try {
      setLanguage('en');
      expect(t('sound.on.done')).toBe(koMap['sound.on.done']);
      expect(t('nope.key')).toBe('nope.key');
    } finally {
      enMap['sound.on.done'] = saved;
    }
  });

  it('AC-111 영어 오류 문구는 문제 + 해결 방법 + 예시(e.g.)를 담는다', () => {
    const bad = Object.entries(enMap).filter(([k, v]) => /^(err|store)\./.test(k) && !/e\.g\./.test(v));
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it('AC-109 언어를 바꿔도 키 확인(hasMessage)은 같다', () => {
    setLanguage('en');
    expect(hasMessage('err.symbol')).toBe(true);
    expect(getLanguage()).toBe('en');
  });
});

describe('영어 복수형 (D-127)', () => {
  it('AC-110 영어는 count에 따라 단수·복수 문구를 고른다', () => {
    setLanguage('en');
    expect(t('del.done', { count: 1 })).toBe('Deleted 1 alert.');
    expect(t('del.done', { count: 3 })).toBe('Deleted 3 alerts.');
    expect(t('del.done', { count: 0 })).toBe('Deleted 0 alerts.');
    expect(t('alert.batch.title', { count: 1 })).toBe('1 alert');
    expect(t('alert.batch.title', { count: 12 })).toBe('12 alerts');
  });

  it('AC-110 count가 숫자가 아니거나 단수형이 없는 키는 기본 문구를 쓴다', () => {
    setLanguage('en');
    expect(t('del.done', { count: '1' })).toBe('Deleted 1 alerts.');
    expect(t('alert.batch.more', { count: 1 })).toBe('and 1 more');
  });

  it('AC-110 한국어는 단수·복수 구분 없이 하나의 문구를 쓴다', () => {
    expect(t('del.done', { count: 1 })).toBe('알림 1개를 삭제했습니다.');
    expect(t('del.done', { count: 3 })).toBe('알림 3개를 삭제했습니다.');
  });
});

/** 알림 유형별 문구(.title)마다, 그 문구·본문·음성 문장에 들어가는 자리표시자를 모두 채운 알림을 만든다 */
function samples(count: number): Alert[] {
  return koKeys
    .filter((k) => /^alert\..*\.title$/.test(k) && k !== 'alert.batch.title')
    .map((titleKey) => {
      const body = titleKey.replace(/\.title$/, '.body');
      const speech = titleKey.replace(/^alert\./, 'speech.').replace(/\.title$/, '');
      const names = new Set([titleKey, body, speech].flatMap((k) => placeholders(koMap[k] ?? '')));
      const params: Record<string, string | number> = {};
      for (const n of names) {
        if (n === 'count') params[n] = count;
        else if (n === 'market') params[n] = 'futures';
        else if (n === 'side') params[n] = titleKey.includes('liq') ? 'LONG' : 'BUY';
        else if (n === 'level') params[n] = 'danger';
        else if (n.endsWith('Ms')) params[n] = 3_600_000;
        else params[n] = n === 'list' ? 'x' : `v_${n}`;
      }
      return { ruleId: 1, kind: 'warn', titleKey, params, firedAt: '2026-10-13T00:00:00.000Z' } as Alert;
    });
}

describe('영어 알림 표시 (FR-I18N-01)', () => {
  it('AC-110 모든 알림 유형이 영어로 표시되고 한글·미채움 자리표시자가 없다', () => {
    setLanguage('en');
    const all = samples(3);
    expect(all.length).toBeGreaterThan(20);
    for (const a of all) {
      const { title, body } = render(a);
      for (const text of [title, body, speechText(a)]) {
        expect(text, a.titleKey).not.toMatch(HANGUL);
        expect(text, a.titleKey).not.toMatch(/\{\w+\}/);
      }
      expect(title, a.titleKey).not.toBe('');
    }
  });

  it('AC-110 단위·값이 영어로 올바르게 보인다 (5m, 1h, buy/sell, long/short, 개수)', () => {
    setLanguage('en');
    const change: Alert = { ruleId: 1, kind: 'up', titleKey: 'alert.change.title', params: { coin: 'BTC', quote: 'USDT', market: 'spot', windowMs: 3_600_000, pct: '+5.2%', from: '60,000', to: '63,120' }, firedAt: 'x' };
    expect(render(change)).toEqual({ title: 'BTC +5.2% in 1h', body: '60,000 → 63,120 USDT · spot' });
    const fill: Alert = { ruleId: 1, kind: 'account', titleKey: 'alert.fill.futures.title', params: { coin: 'ETH', quote: 'USDT', side: 'SELL', qty: '2', price: '3,412.5' }, firedAt: 'x' };
    expect(render(fill)).toEqual({ title: 'ETH futures sell filled', body: '2 ETH @ 3,412.5 USDT' });
    const stage: Alert = { ruleId: 1, kind: 'warn', titleKey: 'alert.liq.stage.title', params: { coin: 'BTC', quote: 'USDT', side: 'LONG', distance: '1.5%', liq: '80,000', mark: '81,200', threshold: '2%', stage: 3, stages: 3, level: 'urgent' }, firedAt: 'x' };
    expect(render(stage)).toEqual({ title: 'BTC futures liquidation urgent 3/3 · 1.5% from liquidation', body: 'long liquidation price 80,000 · mark 81,200 USDT · within 2%' });
    expect(speechText(stage)).toBe('BTC futures liquidation urgent, stage 3, 1.5% from liquidation');
    expect(describeRepeat({ kind: 'cooldown', ms: 300_000 })).toBe('cooldown 5m');
    expect(describeCondition({ type: 'liq', pct: 10, stages: [10, 5, 2] })).toBe('within 10%, 5%, 2% of liquidation (3 stages)');
  });

  it('AC-110 묶음 요약은 1건·여러 건을 영어 단수·복수로 쓴다', () => {
    setLanguage('en');
    const one = summarizeAlerts([samples(1)[0]!]);
    expect(render({ ...one, params: { ...one.params, count: 1 } }).title).toBe('1 alert');
    const many = summarizeAlerts(samples(3).slice(0, 5));
    expect(render(many).title).toBe('5 alerts');
    expect(speechText(many)).toBe('5 alerts');
  });

  it('AC-114 모든 명령에 영어 요약·예시·사용법이 있고 도움말에 한글이 없다', () => {
    setLanguage('en');
    for (const cmd of defaultCommands) {
      expect(enMap[`help.cmd.${cmd.name}.summary`], cmd.name).toBeTruthy();
      if (cmd.hidden) continue; // 내부 명령은 요약만 있다
      expect(enMap[`help.cmd.${cmd.name}.examples`], cmd.name).toBeTruthy();
      for (const k of cmd.usageKeys) expect(enMap[k], k).toBeTruthy();
      if (cmd.name !== 'lang') expect(commandHelp(cmd, true), cmd.name).not.toMatch(HANGUL);
    }
    const visible = defaultCommands.filter((c) => !c.hidden && c.name !== 'lang');
    expect(topHelp(visible, true)).not.toMatch(HANGUL);
    expect(topHelp(defaultCommands.filter((c) => !c.hidden), false)).toContain('Commands:');
  });

  it('AC-114 내장 프리셋 이름과 텔레그램·채널 문구도 영어다', () => {
    setLanguage('en');
    expect(t('preset.major-swing.name')).toBe('Major swings');
    for (const k of koKeys.filter((x) => /^(channel|notify\.telegram|preset|sound|voice|speech|status|stop|start|service|key)\./.test(x))) {
      if (BILINGUAL.has(k)) continue;
      expect(t(k, { count: 2 }), k).not.toMatch(HANGUL);
    }
  });
});

describe('한국어 고정 회귀 (AC-116)', () => {
  it('AC-116 테스트 환경은 한국어로 시작하고 BLERT_LANG의 영향을 받지 않는다', () => {
    expect(getLanguage()).toBe('ko');
    expect(process.env.BLERT_LANG).toBeUndefined();
    expect(t('sound.on.done')).toBe(koMap['sound.on.done']);
  });

  it('AC-116 영어 테스트가 언어를 바꿔도 다음 테스트는 한국어로 시작한다', () => {
    setLanguage('en');
    expect(getLanguage()).toBe('en');
  });

  it('AC-116 (앞 테스트가 en으로 바꾼 뒤에도) 한국어로 시작한다', () => {
    expect(getLanguage()).toBe('ko');
  });
});
