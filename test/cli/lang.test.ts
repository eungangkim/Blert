import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakePresets, makeHarness, type Harness } from './helpers.js';
import { getLanguage, setLanguage } from '../../src/i18n/index.js';
import { RUN_LOCK_STALE_MS } from '../../src/shared/defaults.js';

const HANGUL = /[가-힣]/;
let h: Harness | undefined;
const saved = { LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES, LANG: process.env.LANG, BLERT_LANG: process.env.BLERT_LANG };

beforeEach(() => {
  // OS 로캘에 따라 결과가 달라지지 않게 고정한다
  process.env.LC_ALL = 'ko_KR.UTF-8';
  delete process.env.BLERT_LANG;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await h?.cleanup();
  h = undefined;
});

const text = (x: Harness): string => [...x.out, ...x.err].join('\n');

describe('cli lang (FR-I18N-01, D-124)', () => {
  it('AC-108 lang은 현재 언어와 정해진 방법, 선택지를 보여 준다', async () => {
    h = await makeHarness();
    expect(await h.run('lang')).toBe(0);
    expect(h.out[0]).toBe('현재 언어: 한국어 (ko) · 정해진 방법: OS 언어');
    expect(h.out[1]).toContain('blert lang en');
    process.env.LC_ALL = 'en_US.UTF-8';
    h.out.length = 0;
    await h.run('lang');
    expect(h.out[0]).toContain('English (en)');
  });

  it('AC-108 lang en은 설정에 저장하고 바로 영어로 안내한다. lang으로 다시 보면 영어로 나온다', async () => {
    h = await makeHarness();
    expect(await h.run('lang en')).toBe(0);
    expect((await h.deps.store.loadConfig()).language).toBe('en');
    expect((await h.deps.store.loadConfig()).schemaVersion).toBe(1); // schemaVersion 유지 (D-131)
    expect(getLanguage()).toBe('en');
    expect(h.out[0]).toBe('The language is now English.');
    h.out.length = 0;
    await h.run('lang');
    expect(h.out[0]).toBe('Current language: English (en) · decided by: the setting (blert lang)');
    expect(await h.run('lang KO')).toBe(0);
    expect((await h.deps.store.loadConfig()).language).toBe('ko');
    expect(h.out.at(-1)).toBe('언어를 한국어(으)로 바꿨습니다.');
  });

  it('AC-108 지원하지 않는 언어는 거부하고 종료 코드 1과 예시를 안내한다', async () => {
    h = await makeHarness();
    expect(await h.run('lang xx')).toBe(1);
    expect(h.err.at(-1)).toContain('예: blert lang en');
    expect(await h.run('lang en ko')).toBe(1);
    expect(h.err.at(-1)).toContain('예');
    expect((await h.deps.store.loadConfig()).language).toBeUndefined(); // 아무것도 저장하지 않았다
  });

  it('AC-107 BLERT_LANG이 있으면 설정보다 우선하고, 바꾸려는 값과 다르면 알려 준다', async () => {
    h = await makeHarness();
    process.env.BLERT_LANG = 'ko';
    await h.run('lang en');
    expect((await h.deps.store.loadConfig()).language).toBe('en'); // 설정은 저장된다
    expect(text(h)).toContain('BLERT_LANG environment variable is set to `ko`');
    h.out.length = 0;
    setLanguage('ko');
    await h.run('lang');
    expect(h.out[0]).toContain('정해진 방법: BLERT_LANG 환경 변수');
  });

  it('AC-115 감시가 실행 중일 때 언어를 바꾸면 재시작이 필요하다고 안내한다', async () => {
    h = await makeHarness();
    await h.run('lang ko');
    h.out.length = 0;
    expect(await h.run('lang en')).toBe(0);
    expect(text(h)).not.toContain('restart'); // 실행 중인 감시가 없으면 안내하지 않는다

    const now = h.sim.nowMs;
    const r = await h.deps.store.acquireRunLock({ pid: process.pid, now, staleMs: RUN_LOCK_STALE_MS, mode: 'daemon' });
    expect(r.ok).toBe(true);
    h.out.length = 0;
    expect(await h.run('lang ko')).toBe(0);
    expect(text(h)).toContain('blert stop 다음 blert start');
    h.out.length = 0;
    expect(await h.run('lang en')).toBe(0);
    expect(text(h)).toContain('A running monitor keeps the language it started with');
    expect(text(h)).toContain('blert stop, then blert start');
    await h.deps.store.releaseRunLock(process.pid);
  });
});

describe('cli init 언어 질문 (D-124)', () => {
  it('AC-112 첫 질문은 언어이고, 2를 고르면 이후 안내가 영어로 나오며 설정에 저장된다', async () => {
    h = await makeHarness(['2', 'y', 'n', ''], fakePresets([]));
    expect(await h.run('init')).toBe(0);
    expect(h.asked[0]).toBe('언어 / Language — 1) 한국어  2) English (Enter = 1): ');
    expect(h.asked[1]).toBe('Do you agree with the above? (y/n) ');
    expect(h.out[0]).toContain('blert is not investment advice');
    expect((await h.deps.store.loadConfig()).language).toBe('en');
    expect(getLanguage()).toBe('en');
    expect(h.out.join('\n')).not.toMatch(HANGUL);
    expect(h.out.at(-1)).toContain('blert run');
  });

  it('AC-112 1 또는 ko를 고르면 한국어로 진행한다 (OS가 영어여도)', async () => {
    process.env.LC_ALL = 'en_US.UTF-8';
    h = await makeHarness(['1', 'y', 'n', ''], fakePresets([]));
    expect(await h.run('init')).toBe(0);
    expect(h.asked[0]).toContain('(Enter = 2)'); // 기본은 OS 로캘 기준
    expect((await h.deps.store.loadConfig()).language).toBe('ko');
    expect(h.out[0]).toContain('투자 조언이 아니며');
  });

  it('AC-112 빈 입력은 OS 로캘 기본을 따른다 (영어 OS → 영어, 한국어 OS → 한국어)', async () => {
    process.env.LC_ALL = 'en_GB.UTF-8';
    h = await makeHarness(['', 'y', 'n', ''], fakePresets([]));
    await h.run('init');
    expect((await h.deps.store.loadConfig()).language).toBe('en');
    await h.cleanup();
    process.env.LC_ALL = 'ko_KR.UTF-8';
    h = await makeHarness(['', 'y', 'n', ''], fakePresets([]));
    await h.run('init');
    expect((await h.deps.store.loadConfig()).language).toBe('ko');
  });

  it('AC-112 입력이 끝났거나 알 수 없는 답을 3번 하면 기본 언어로 진행한다', async () => {
    process.env.LC_ALL = 'en_US.UTF-8';
    h = await makeHarness([]); // 입력 없음
    expect(await h.run('init')).toBe(1); // 이후 동의 질문에서 입력이 없어 중단
    expect((await h.deps.store.loadConfig()).language).toBe('en');
    expect(h.err.at(-1)).toContain('Cannot read input');
    await h.cleanup();

    process.env.LC_ALL = 'ko_KR.UTF-8';
    h = await makeHarness(['??', '9', 'fr', 'n']);
    expect(await h.run('init')).toBe(1); // 마지막 'n'은 고지 동의 거부
    expect(h.asked.slice(0, 3).every((q) => q.startsWith('언어 / Language'))).toBe(true);
    expect((await h.deps.store.loadConfig()).language).toBe('ko');
  });

  it('AC-112 BLERT_LANG으로 언어를 정해 둔 경우에는 언어를 묻지 않는다', async () => {
    process.env.BLERT_LANG = 'en';
    setLanguage('en');
    h = await makeHarness(['y', 'n', ''], fakePresets([]));
    expect(await h.run('init')).toBe(0);
    expect(h.asked[0]).toBe('Do you agree with the above? (y/n) ');
    expect((await h.deps.store.loadConfig()).language).toBeUndefined();
  });

  it('AC-112 이미 설정된 언어가 있으면 그것이 기본이 된다', async () => {
    process.env.LC_ALL = 'ko_KR.UTF-8';
    h = await makeHarness(['', 'y', 'n', ''], fakePresets([]));
    await h.deps.store.updateConfig((c) => {
      c.language = 'en';
    });
    await h.run('init');
    expect(h.asked[0]).toContain('(Enter = 2)');
    expect((await h.deps.store.loadConfig()).language).toBe('en');
  });
});

describe('영어 CLI 흐름 (AC-114)', () => {
  it('AC-114 영어에서 주요 명령의 출력에 한글이 없다 (사용자 데이터 제외)', async () => {
    h = await makeHarness([], 'real');
    setLanguage('en');
    const cmds = [
      'add price BTC above 70000',
      'add liq f:BTC 10%,5%,2%',
      'list',
      'pause 1',
      'resume 1',
      'preset list',
      'preset install major-swing',
      'preset remove major-swing',
      'sound list',
      'sound on',
      'sound off',
      'voice on',
      'voice kinds up,warn',
      'voice list',
      'voice use Voice En',
      'voice test',
      'voice off',
      'status',
      'channel',
      'del all',
      'list',
    ];
    for (const c of cmds) await h.run(c);
    // 오류 문구도 영어다
    for (const c of ['add price BTC sideways 1', 'add nope', 'preset install nope', 'sound set up', 'voice use Nobody', 'foo', 'del 99']) {
      expect(await h.run(c), c).toBeGreaterThan(0);
    }
    expect(text(h)).not.toMatch(/[가-힣]/);
    expect(h.err.every((e) => /e\.g\./.test(e)), h.err.join('\n')).toBe(true);
    expect(h.out.join('\n')).toContain('Added alert #1');
    expect(h.out.join('\n')).toContain('Deleted 3 alerts.');
  });

  it('AC-114 영어의 단수·복수가 명령 출력에 반영된다', async () => {
    h = await makeHarness([], 'real');
    setLanguage('en');
    await h.run('add price BTC above 70000');
    h.out.length = 0;
    await h.run('del all');
    expect(h.out[0]).toBe('Deleted 1 alert.');
  });
});
