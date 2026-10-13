import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeHarness, type Harness } from './helpers.js';
import { sha256Hex } from '../../src/shared/wav.js';
import { presetText } from '../presets/extfixture.js';

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const all = (): string => [...h.out, ...h.err].join('\n');
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const okDl = (bytes: Uint8Array, url: string) => ({ ok: true as const, bytes, sha256: sha256Hex(bytes), finalUrl: url });
const real = () => makeHarness([], 'real');

async function writePreset(name: string, text = presetText()): Promise<string> {
  const path = join(h.dir, name);
  await writeFile(path, text);
  return path;
}

describe('blert preset install <파일> (FR-PRE-03)', () => {
  it('AC-85 파일로 설치하면 규칙이 추가되고 외부 요청은 없다. 동의 질문은 없다 (D-106)', async () => {
    h = await real();
    const path = await writePreset('p.json');
    expect(await h.run(`preset install ${path}`)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('BTC 돌파 감시');
    expect(text).toContain('출처: file');
    expect(text).toContain('CC0-1.0');
    expect(text).toContain('규칙 3개: price 1, change 1, funding 1');
    expect(text).toContain('sha256: ' + sha256Hex(enc(presetText())));
    expect(text).toContain('알림 3개를 등록');
    expect(h.asked).toEqual([]);
    expect(h.dl.calls).toEqual([]);
    expect(await h.deps.store.loadRules()).toHaveLength(3);
    const rec = (await h.deps.store.loadConfig()).presets[0]!;
    expect(rec).toMatchObject({ slug: 'btc-breakout', version: 2, source: 'file', sha256: sha256Hex(enc(presetText())) });
  });

  it('AC-85 요약에 규칙을 한 줄씩 보여 준다 (10개 초과는 개수만)', async () => {
    h = await real();
    const rule = (i: number) => ({ type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 100 + i } });
    const path = await writePreset('many.json', presetText({ rules: Array.from({ length: 13 }, (_, i) => rule(i)) }));
    expect(await h.run(`preset install ${path}`)).toBe(0);
    expect(h.out.filter((l) => l.startsWith('  - ')).length).toBe(10);
    expect(h.out.join('\n')).toContain('… 외 3개');
  });

  it('AC-85 계정 규칙이 있으면 키 등록 안내를 요약에 넣는다 (D-103)', async () => {
    h = await real();
    const path = await writePreset('acct.json', presetText({ rules: [{ type: 'liq', market: 'futures', symbol: 'BTCUSDT', condition: { type: 'liq', pct: 8 } }] }));
    expect(await h.run(`preset install ${path}`)).toBe(0);
    expect(h.out.join('\n')).toContain('API 키 등록이 필요');
  });

  it('AC-87 --sha256이 맞으면 설치하고 틀리면 설치하지 않는다 (파일)', async () => {
    h = await real();
    const path = await writePreset('p.json');
    expect(await h.run(`preset install ${path} --sha256 ${'0'.repeat(64)}`)).toBe(1);
    expect(all()).toContain('해시가 지정한 값과 다릅니다');
    expect(await h.deps.store.loadRules()).toEqual([]);
    expect(await h.run(`preset install ${path} --sha256 ${sha256Hex(enc(presetText())).toUpperCase()}`)).toBe(0);
    expect(await h.run(`preset install ${path} --sha256 abc`)).toBe(1);
  });

  it('AC-88 잘못된 파일은 하나도 설치하지 않고 문제 위치와 예시를 안내 (종료 코드 1)', async () => {
    h = await real();
    const rules = [
      { type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: 1 } },
      { type: 'price', market: 'spot', symbol: 'BTCUSDT', condition: { type: 'price', direction: 'above', price: -5 } },
    ];
    expect(await h.run(`preset install ${await writePreset('bad.json', presetText({ rules }))}`)).toBe(1);
    expect(all()).toContain('rules[1].condition.price');
    expect(all()).toContain('아무것도 설치하지 않았습니다');
    expect(all()).toContain('예:');
    expect(await h.run(`preset install ${await writePreset('junk.json', 'not json')}`)).toBe(1);
    expect(all()).toContain('JSON 형식');
    expect(await h.run(`preset install ${await writePreset('v9.json', presetText({ schemaVersion: 9 }))}`)).toBe(1);
    expect(all()).toContain('지원하지 않는 프리셋 파일 버전');
    expect(await h.run(`preset install ${await writePreset('slug.json', presetText({ slug: '../x' }))}`)).toBe(1);
    expect(all()).toContain('slug가 올바르지 않습니다');
    expect(await h.deps.store.loadRules()).toEqual([]);
    expect((await h.deps.store.loadConfig()).presets).toEqual([]);
  });

  it('AC-88 없는 파일·너무 큰 파일은 안내한다', async () => {
    h = await real();
    expect(await h.run(`preset install ${join(h.dir, 'nope.json')}`)).toBe(1);
    expect(all()).toContain('프리셋 파일을 읽지 못했습니다');
    const big = await writePreset('big.json', 'x'.repeat(256 * 1024 + 1));
    expect(await h.run(`preset install ${big}`)).toBe(1);
    expect(all()).toContain('너무 커서');
  });

  it('AC-89 내장 슬러그·설치된 슬러그는 거절하고 해결 방법을 안내', async () => {
    h = await real();
    expect(await h.run(`preset install ${await writePreset('b.json', presetText({ slug: 'major-swing' }))}`)).toBe(1);
    expect(all()).toContain('내장 프리셋 이름');
    h.err.length = 0;
    const path = await writePreset('p.json');
    expect(await h.run(`preset install ${path}`)).toBe(0);
    expect(await h.run(`preset install ${path}`)).toBe(1);
    expect(all()).toContain('blert preset remove btc-breakout');
    expect(await h.deps.store.loadRules()).toHaveLength(3);
  });

  it('AC-89 슬러그 형식의 인자는 내장 프리셋 이름으로 본다 (D-105)', async () => {
    h = await real();
    expect(await h.run('preset install btc-breakout')).toBe(1);
    expect(all()).toContain('프리셋 `btc-breakout`이(가) 없습니다');
    expect(h.dl.calls).toEqual([]);
    expect(await h.run('preset install major-swing --sha256 ' + '0'.repeat(64))).toBe(1);
    expect(all()).toContain('--sha256은 파일이나 주소로 설치할 때만');
    expect(await h.run('preset list --sha256 ' + '0'.repeat(64))).toBe(1);
  });
});

describe('blert preset install <https주소> (FR-PRE-03)', () => {
  const url = 'https://presets.example.com/pack/btc.json?token=SECRET#frag';

  it('AC-86 출처·이름·라이선스·규칙 수·해시를 보여 주고 y면 설치한다. 기록에는 쿼리가 없다', async () => {
    h = await makeHarness(['y'], 'real');
    const bytes = enc(presetText());
    h.dl.responses.set(url, okDl(bytes, url));
    expect(await h.run(`preset install ${url}`)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('출처: presets.example.com/pack/btc.json');
    expect(text).toContain(sha256Hex(bytes));
    expect(text).not.toContain('SECRET');
    expect(h.asked[0]).toContain('(y/N)');
    expect(h.dl.calls).toEqual([{ url, maxBytes: 256 * 1024 }]);
    expect(await h.deps.store.loadRules()).toHaveLength(3);
    const cfg = await h.deps.store.loadConfig();
    expect(cfg.presets[0]).toMatchObject({ source: 'presets.example.com/pack/btc.json', sha256: sha256Hex(bytes) });
    expect(JSON.stringify(cfg)).not.toContain('SECRET');
  });

  it('AC-86 n이거나 그냥 Enter면 설치하지 않는다 (기본 No)', async () => {
    h = await makeHarness(['', 'n'], 'real');
    h.dl.responses.set(url, okDl(enc(presetText()), url));
    expect(await h.run(`preset install ${url}`)).toBe(1);
    expect(all()).toContain('설치하지 않았습니다');
    expect(await h.run(`preset install ${url}`)).toBe(1);
    expect(await h.deps.store.loadRules()).toEqual([]);
    expect((await h.deps.store.loadConfig()).presets).toEqual([]);
  });

  it('AC-87 주소 방식에서 해시가 다르면 동의를 묻기 전에 거부', async () => {
    h = await makeHarness(['y'], 'real');
    h.dl.responses.set(url, okDl(enc(presetText()), url));
    expect(await h.run(`preset install ${url} --sha256 ${'a'.repeat(64)}`)).toBe(1);
    expect(h.asked).toEqual([]);
    expect(await h.deps.store.loadRules()).toEqual([]);
  });

  it('AC-88 주소로 받은 잘못된 파일은 동의를 묻기 전에 거부', async () => {
    h = await makeHarness(['y'], 'real');
    h.dl.responses.set(url, okDl(enc('<html>not a preset</html>'), url));
    expect(await h.run(`preset install ${url}`)).toBe(1);
    expect(h.asked).toEqual([]);
  });

  it('AC-89 슬러그가 겹치면 동의를 묻기 전에 거절한다', async () => {
    h = await makeHarness(['y'], 'real');
    h.dl.responses.set(url, okDl(enc(presetText({ slug: 'volume-burst' })), url));
    expect(await h.run(`preset install ${url}`)).toBe(1);
    expect(h.asked).toEqual([]);
  });

  it('AC-91 http·리다이렉트·크기·시간 초과는 설치 없이 안내하고 상한은 256KB다', async () => {
    h = await makeHarness([], 'real');
    const cases: [string, string, number][] = [
      ['insecure', 'https 주소만', 1],
      ['redirect', '다른 주소로', 1],
      ['too-large', '너무 커서', 1],
      ['timeout', '10초 안에', 3],
      ['network', '내려받지 못했습니다', 3],
    ];
    for (const [reason, text, code] of cases) {
      h.out.length = 0;
      h.err.length = 0;
      h.dl.responses.set(url, { ok: false, reason: reason as never });
      expect(await h.run(`preset install ${url}`), reason).toBe(code);
      expect(all(), reason).toContain(text);
    }
    expect(h.dl.calls.every((c) => c.maxBytes === 256 * 1024)).toBe(true);
    expect(await h.deps.store.loadRules()).toEqual([]);
  });

  it('AC-91 주소 입력이 없는 명령은 네트워크 요청을 하지 않는다', async () => {
    h = await real();
    const path = await writePreset('p.json');
    await h.run(`preset install ${path}`);
    await h.run('preset list');
    await h.run('preset install major-swing');
    await h.run('preset remove btc-breakout');
    expect(h.dl.calls).toEqual([]);
  });
});

describe('blert preset list / remove (외부 프리셋)', () => {
  it('AC-92 list에 출처와 해시 앞 8자리를 보이고 remove로 그 규칙만 지운다', async () => {
    h = await real();
    await h.run('preset install major-swing');
    const path = await writePreset('p.json');
    await h.run(`preset install ${path}`);
    h.out.length = 0;
    expect(await h.run('preset list')).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('출처(해시)');
    expect(text).toContain('btc-breakout');
    expect(text).toContain('BTC 돌파 감시');
    expect(text).toContain(`file (${sha256Hex(enc(presetText())).slice(0, 8)}…)`);

    h.out.length = 0;
    expect(await h.run('preset remove btc-breakout')).toBe(0);
    expect(h.out.join('\n')).toContain('BTC 돌파 감시');
    expect(h.out.join('\n')).toContain('알림 3개를 삭제');
    const rules = await h.deps.store.loadRules();
    expect(rules.length).toBe(3); // major-swing의 규칙은 그대로
    expect(rules.every((r) => r.source === 'preset:major-swing')).toBe(true);
  });

  it('AC-92 외부 프리셋이 없으면 list에 출처 열을 더하지 않는다 (기존 표 유지)', async () => {
    h = await real();
    await h.run('preset list');
    expect(h.out.join('\n')).not.toContain('출처(해시)');
  });
});
