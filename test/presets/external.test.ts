import { describe, expect, it } from 'vitest';
import { parseExternalPreset, countByType, needsKey } from '../../src/presets/external.js';
import { presetJson, presetText } from './extfixture.js';

type Rules = Record<string, unknown>[];
const withRule = (rule: Record<string, unknown>): string => presetText({ rules: [rule] });
const field = (text: string): string | undefined => {
  const r = parseExternalPreset(text);
  return r.ok ? undefined : r.problem.kind === 'field' ? r.problem.field : r.problem.kind;
};

describe('외부 프리셋 검증 (D-79, D-101~D-104)', () => {
  it('AC-85 유효한 파일은 규칙을 기본 반복 정책과 함께 돌려준다', () => {
    const r = parseExternalPreset(presetText());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ slug: 'btc-breakout', version: 2, name: 'BTC 돌파 감시', license: 'CC0-1.0', author: '시험' });
    expect(r.value.rules).toHaveLength(3);
    expect(r.value.rules[0]!.repeat).toEqual({ kind: 'cooldown', ms: 300000 });
    expect(r.value.rules[2]!.repeat).toEqual({ kind: 'hysteresis', widthPct: 20 }); // funding 기본값
    expect(r.value.rules[1]).toMatchObject({ sound: 'warn', name: 'ETH 급변' });
  });

  it('AC-88 JSON이 아니거나 객체가 아니면 거부', () => {
    expect(field('not json')).toBe('json');
    expect(field('[1,2]')).toBe('json');
    expect(field('null')).toBe('json');
  });

  it('AC-88 모르는 schemaVersion은 거부', () => {
    for (const v of [2, 0, '1', undefined]) expect(field(presetText({ schemaVersion: v })), String(v)).toBe('schema');
  });

  it('AC-89 슬러그는 영문 소문자·숫자·하이픈 3~40자만', () => {
    for (const slug of ['AB-cd', 'a b c', '../evil', 'ab', 'x'.repeat(41), 'a/b', '', 5]) expect(field(presetText({ slug })), String(slug)).toBe('slug');
    expect(field(presetText({ slug: 'abc' }))).toBeUndefined();
  });

  it.each([
    ['version', { version: 0 }],
    ['version', { version: 1.5 }],
    ['name', { name: '' }],
    ['name', { name: 'x'.repeat(41) }],
    ['description', { description: 'x'.repeat(201) }],
    ['license', { license: undefined }],
    ['author', { author: 7 }],
    ['rules', { rules: [] }],
    ['rules', { rules: 'nope' }],
  ])('AC-88 %s 항목이 틀리면 거부 %#', (expected, over) => {
    expect(field(presetText(over))).toBe(expected);
  });

  it('AC-88 규칙은 50개까지, 51개는 하나도 받지 않는다', () => {
    const rule = { type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 1 } };
    expect(parseExternalPreset(presetText({ rules: Array.from({ length: 50 }, () => rule) })).ok).toBe(true);
    expect(field(presetText({ rules: Array.from({ length: 51 }, () => rule) }))).toBe('rules');
  });

  it('AC-88 이름·설명·라이선스·작성자·규칙 이름에 제어 문자(ANSI 이스케이프 포함)가 있으면 거부', () => {
    const esc = String.fromCharCode(27);
    for (const f of ['name', 'description', 'license', 'author']) expect(field(presetText({ [f]: `a${esc}[31mb` })), f).toBe(f);
    expect(field(presetText({ name: 'a\nb' }))).toBe('name');
    expect(field(presetText({ name: 'a b' }))).toBe('name');
    const rule = { type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 1 }, name: `x${esc}]0;title` };
    expect(field(withRule(rule))).toBe('rules[0].name');
  });

  it('AC-88 문제 위치를 규칙 번호와 항목으로 알려 준다', () => {
    const base = presetJson().rules as Rules;
    const rules = [base[0]!, { ...base[1]!, condition: { type: 'change', pct: -1, windowMs: 3600000, direction: 'both' } }];
    expect(field(presetText({ rules }))).toBe('rules[1].condition.pct');
  });

  it.each([
    ['rules[0].type', { type: 'swap', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'swap' } }],
    ['rules[0].market', { type: 'price', market: 'margin', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 1 } }],
    ['rules[0].symbol', { type: 'price', market: 'spot', symbol: 'btc', condition: { type: 'price', direction: 'above', price: 1 } }],
    ['rules[0].symbol', { type: 'price', market: 'spot', symbol: 'BTC', condition: { type: 'price', direction: 'above', price: 1 } }],
    ['rules[0].symbol', { type: 'price', market: 'spot', symbol: '*', condition: { type: 'price', direction: 'above', price: 1 } }],
    ['rules[0].condition.type', { type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'change' } }],
    ['rules[0].condition.direction', { type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'up', price: 1 } }],
    ['rules[0].condition.price', { type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 0 } }],
    ['rules[0].condition.price', { type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: '1' } }],
    ['rules[0].condition.windowMs', { type: 'change', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'change', pct: 5, windowMs: 1000, direction: 'both' } }],
    ['rules[0].condition.windowMs', { type: 'change', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'change', pct: 5, windowMs: 90000000, direction: 'both' } }],
    ['rules[0].condition.multiple', { type: 'volume', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'volume', multiple: 1, shortMs: 300000, longMs: 3600000 } }],
    ['rules[0].condition.longMs', { type: 'volume', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'volume', multiple: 3, shortMs: 3600000, longMs: 300000 } }],
    ['rules[0].market', { type: 'funding', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'funding', direction: 'above', pct: 0.05 } }],
    ['rules[0].condition.pct', { type: 'funding', market: 'futures', symbol: 'BTCUSDT', condition: { type: 'funding', direction: 'above', pct: Infinity } }],
    ['rules[0].market', { type: 'liq', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'liq', pct: 5 } }],
    ['rules[0].condition.pct', { type: 'liq', market: 'futures', symbol: 'BTCUSDT', condition: { type: 'liq', pct: 100 } }],
    ['rules[0].symbol', { type: 'fill', market: 'futures', symbol: '*', condition: { type: 'fill' } }],
    ['rules[0].market', { type: 'balance', market: 'futures', symbol: '*', condition: { type: 'balance', asset: 'USDT', pct: 5 } }],
    ['rules[0].condition.asset', { type: 'balance', market: 'spot', symbol: '*', condition: { type: 'balance', asset: 'usdt!', pct: 5 } }],
    ['rules[0].sound', { type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 1 }, sound: 'loud' }],
    ['rules[0].repeat.kind', { type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 1 }, repeat: { kind: 'each' } }],
    ['rules[0].repeat.ms', { type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 1 }, repeat: { kind: 'cooldown', ms: 1000 } }],
    ['rules[0].repeat.widthPct', { type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 1 }, repeat: { kind: 'hysteresis', widthPct: 101 } }],
    ['rules[0].repeat', { type: 'fill', market: 'spot', symbol: '*', condition: { type: 'fill' }, repeat: { kind: 'once' } }],
  ])('AC-88 규칙 값이 틀리면 %s로 거부 %#', (expected, rule) => {
    expect(field(withRule(rule))).toBe(expected);
  });

  it('AC-88 계정 규칙(fill, balance, liq)도 올바르면 받는다 (D-103)', () => {
    const rules = [
      { type: 'fill', market: 'spot', symbol: '*', condition: { type: 'fill' } },
      { type: 'fill', market: 'futures', symbol: 'BTCUSDT', condition: { type: 'fill' } },
      { type: 'balance', market: 'spot', symbol: '*', condition: { type: 'balance', asset: 'USDT', pct: 5 } },
      { type: 'liq', market: 'futures', symbol: 'BTCUSDT', condition: { type: 'liq', pct: 8 } },
    ];
    const r = parseExternalPreset(presetText({ rules }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rules.map((x) => x.repeat.kind)).toEqual(['each', 'each', 'cooldown', 'cooldown']);
    expect(r.value.rules.every(needsKey)).toBe(true);
    expect(countByType(r.value.rules)).toEqual({ fill: 2, balance: 1, liq: 1 });
  });

  it('AC-90 파일이 주장한 source와 모르는 항목은 결과에 담기지 않는다', () => {
    const rule = { type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 1, extra: 'x' }, source: 'manual', enabled: false, id: 99, createdAt: 'x', __proto__: { polluted: true } };
    const r = parseExternalPreset(presetText({ rules: [rule], hacked: true, extra: { a: 1 } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = JSON.stringify(r.value);
    for (const word of ['manual', 'enabled', 'createdAt', 'extra', 'hacked', '"id"', 'source']) expect(out, word).not.toContain(word);
  });
});

describe('외부 프리셋의 단계별 청산 경고 (D-121)', () => {
  const liq = (condition: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'liq', market: 'futures', symbol: 'BTCUSDT', condition: { type: 'liq', ...condition }, ...extra });

  it('AC-104 stages는 단일 임계값과 같은 한도로 받고, 첫 값은 pct와 같아야 한다', () => {
    const r = parseExternalPreset(presetText({ rules: [liq({ pct: 10, stages: [10, 5, 2] })] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.rules[0]!.condition).toEqual({ type: 'liq', pct: 10, stages: [10, 5, 2] });
  });

  it.each([
    ['오름차순', { pct: 2, stages: [2, 5, 10] }],
    ['1단계', { pct: 10, stages: [10] }],
    ['5단계', { pct: 50, stages: [50, 40, 30, 20, 10] }],
    ['첫 값과 pct 불일치', { pct: 8, stages: [10, 5] }],
    ['숫자가 아님', { pct: 10, stages: [10, '5'] }],
    ['배열이 아님', { pct: 10, stages: '10,5' }],
  ])('AC-104 %s는 거부하고 stages 위치를 알려 준다', (_n, condition) => {
    expect(field(withRule(liq(condition)))).toBe('rules[0].condition.stages');
  });

  it('AC-104 pct가 100 이상이면 pct 위치로 거부', () => {
    expect(field(withRule(liq({ pct: 100, stages: [100, 5] })))).toBe('rules[0].condition.pct');
  });

  it('AC-104 단계 규칙의 repeat는 쿨다운만 받는다', () => {
    const c = { pct: 10, stages: [10, 5] };
    expect(parseExternalPreset(presetText({ rules: [liq(c, { repeat: { kind: 'cooldown', ms: 600000 } })] })).ok).toBe(true);
    expect(field(withRule(liq(c, { repeat: { kind: 'once' } })))).toBe('rules[0].repeat.kind');
    expect(field(withRule(liq(c, { repeat: { kind: 'hysteresis', widthPct: 10 } })))).toBe('rules[0].repeat.kind');
  });
});
