import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers.js';
import { VoiceAdapter } from '../../src/notify/voice.js';
import type { Alert } from '../../src/shared/types.js';

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

const all = (): string => [...h.out, ...h.err].join('\n');
const liq: Alert = { ruleId: 1, kind: 'warn', titleKey: 'alert.liq.title', params: { coin: 'BTC', distance: '3.6%' }, firedAt: '2026-10-13T00:00:00.000Z' };

describe('cli voice (FR-NOTI-05, D-112, D-116)', () => {
  it('AC-95 voice on은 켜고 기본 종류(warn, account)를 안내한다. off는 종류를 보존한 채 끈다', async () => {
    expect((await h.deps.store.loadConfig()).voice).toBeUndefined();
    expect(await h.run('voice on')).toBe(0);
    expect((await h.deps.store.loadConfig()).voice).toEqual({ enabled: true, kinds: ['warn', 'account'] });
    expect(h.out.join('\n')).toContain('음성 알림을 켰습니다');
    expect(h.out.join('\n')).toContain('warn, account');
    expect(await h.run('voice off')).toBe(0);
    expect((await h.deps.store.loadConfig()).voice).toEqual({ enabled: false, kinds: ['warn', 'account'] });
    expect((await h.deps.store.loadConfig()).schemaVersion).toBe(1); // 선택 항목이라 schemaVersion 유지 (D-121)
  });

  it('AC-95 voice kinds는 쉼표 목록을 정해진 순서로 중복 없이 저장한다', async () => {
    expect(await h.run('voice kinds Warn,up,warn')).toBe(0);
    expect((await h.deps.store.loadConfig()).voice).toEqual({ enabled: false, kinds: ['up', 'warn'] });
    expect(h.out.join('\n')).toContain('up, warn');
  });

  it.each(['voice kinds', 'voice kinds loud', 'voice kinds up,', 'voice kinds up down', 'voice kinds ,'])('AC-95 %s는 거부 (종료 코드 1, 예시 포함)', async (cmd) => {
    expect(await h.run(cmd)).toBe(1);
    expect(h.err.at(-1)).toContain('예');
    expect((await h.deps.store.loadConfig()).voice).toBeUndefined();
  });

  it('AC-95 voice test는 설정과 무관하게 시험 문장을 읽는다 (선택한 음성이 있으면 그 음성으로)', async () => {
    expect(await h.run('voice test')).toBe(0);
    expect(h.vo.spoken).toEqual([{ text: 'blert 음성 시험입니다. 이 소리가 들리면 정상입니다.' }]);
    await h.run('voice use Voice En');
    await h.run('voice test');
    expect(h.vo.spoken.at(-1)).toMatchObject({ voiceName: 'Voice En' });
  });

  it('AC-99 voice test가 실패하면 원인과 해결 방법을 안내한다 (종료 코드 1)', async () => {
    h.vo.failSpeak = 'no tts';
    expect(await h.run('voice test')).toBe(1);
    expect(all()).toContain('no tts');
    expect(h.err.at(-1)).toContain('예: blert voice test');
  });

  it('AC-99 voice on은 음성을 확인하지 못해도 켜고 주의를 알린다', async () => {
    h.vo.failList = 'powershell missing';
    expect(await h.run('voice on')).toBe(0);
    expect((await h.deps.store.loadConfig()).voice?.enabled).toBe(true);
    expect(h.out.join('\n')).toContain('확인하지 못했습니다');
  });

  it('AC-95 알 수 없는 하위 명령은 오타를 제안하고, 인자 없는 호출은 사용법을 안내한다', async () => {
    expect(await h.run('voice onn')).toBe(1);
    expect(h.err.at(-1)).toContain('혹시 `on`');
    expect(await h.run('voice')).toBe(1);
    expect(h.err.at(-1)).toContain('on, off, kinds, list, use, test');
    expect(await h.run('voice on extra')).toBe(1);
  });

  it('AC-101 voice list는 상태와 설치된 음성을 보여 주고 선택한 음성에 *를 붙인다', async () => {
    await h.run('voice use Voice Ko');
    h.out.length = 0;
    expect(await h.run('voice list')).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('음성 알림: 꺼짐');
    expect(text).toContain('선택한 음성: Voice Ko');
    expect(text).toContain('* Voice Ko (ko-KR)');
    expect(text).toContain('  Voice En (en-US)');
  });

  it('AC-101 voice list에서 설치된 음성이 없거나 조회에 실패하면 안내한다', async () => {
    h.vo.voices = [];
    await h.run('voice list');
    expect(h.out.join('\n')).toContain('설치된 음성이 없습니다');
    h.vo.failList = 'boom';
    expect(await h.run('voice list')).toBe(1);
    expect(h.err.at(-1)).toContain('boom');
    expect(h.err.at(-1)).toContain('예');
  });

  it('AC-101 voice use는 이름(대소문자·공백 허용)을 설치된 음성과 맞춰 저장하고, default로 되돌린다', async () => {
    expect(await h.run('voice use voice ko')).toBe(0); // 따옴표 없이 공백이 든 이름
    expect((await h.deps.store.loadConfig()).voice).toMatchObject({ voiceName: 'Voice Ko' });
    expect(h.out.at(-1)).toContain('`Voice Ko`');
    await h.run('voice on');
    await h.run('voice kinds up');
    expect(await h.run('voice use default')).toBe(0);
    expect((await h.deps.store.loadConfig()).voice).toEqual({ enabled: true, kinds: ['up'] }); // 켜기·종류는 유지
  });

  it('AC-101 없는 음성 이름은 거부하고 설치된 음성과 예시를 안내 (종료 코드 1)', async () => {
    expect(await h.run('voice use Nobody')).toBe(1);
    expect(h.err.at(-1)).toContain('Voice Ko, Voice En');
    expect(h.err.at(-1)).toContain('예: blert voice use Voice Ko');
    expect((await h.deps.store.loadConfig()).voice).toBeUndefined();
    expect(await h.run('voice use')).toBe(1);
  });

  it('AC-100 다른 터미널에서 voice on/use를 하면 실행 중인 어댑터가 재시작 없이 따른다', async () => {
    const spoken: { text: string; voiceName?: string }[] = [];
    const adapter = new VoiceAdapter({
      engine: { speak: async (text, voiceName) => void spoken.push({ text, ...(voiceName ? { voiceName } : {}) }) },
      config: async () => (await h.deps.store.loadConfig()).voice, // index.ts의 연결과 같은 방식
    });
    await adapter.send([liq]);
    expect(spoken).toEqual([]); // 아직 꺼짐
    await h.run('voice on');
    await adapter.send([liq]);
    await h.run('voice use Voice En');
    await adapter.send([liq]);
    await h.run('voice off');
    await adapter.send([liq]);
    expect(spoken).toEqual([{ text: 'BTC 선물 청산가까지 3.6%' }, { text: 'BTC 선물 청산가까지 3.6%', voiceName: 'Voice En' }]);
  });
});
