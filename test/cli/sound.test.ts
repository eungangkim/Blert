import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(() => h.cleanup());

describe('cli sound / test (FR-NOTI-01~02)', () => {
  it('AC-18 sound test up → sound off → test: 소리 시험 후, 끈 뒤에는 알림만 표시한다', async () => {
    expect(await h.run('sound test up')).toBe(0);
    expect(h.calls).toEqual(['soundTest:up']);
    expect(h.out.at(-1)).toContain('`up` 소리를 재생합니다');

    expect(await h.run('sound off')).toBe(0);
    expect((await h.deps.store.loadConfig()).soundEnabled).toBe(false);
    expect(await h.run('test')).toBe(0);
    expect(h.calls).toEqual(['soundTest:up', 'test:up']);
    expect(h.out.at(-1)).toContain('알림만 표시');

    expect(await h.run('sound on')).toBe(0);
    expect((await h.deps.store.loadConfig()).soundEnabled).toBe(true);
    await h.run('test');
    expect(h.out.at(-1)).not.toContain('알림만 표시');
  });

  it('소리가 꺼져 있어도 sound test는 재생하되 꺼져 있다고 알려준다', async () => {
    await h.run('sound off');
    expect(await h.run('sound test warn')).toBe(0);
    expect(h.calls).toEqual(['soundTest:warn']);
    expect(h.out.join('\n')).toContain('소리가 꺼져 있지만 시험을 위해 재생합니다');
  });

  it('test는 유형을 받고 기본은 up이다', async () => {
    await h.run('test');
    await h.run('test warn');
    await h.run('test DOWN');
    expect(h.calls).toEqual(['test:up', 'test:warn', 'test:down']);
    expect(h.out.at(-1)).toContain('시험 알림(down)');
  });

  it('잘못된 유형·하위 명령은 오타를 제안하고 종료 코드 1', async () => {
    expect(await h.run('test bad')).toBe(1);
    expect(h.err[0]).toContain('up, down, account, warn');
    expect(await h.run('sound test upp')).toBe(1);
    expect(h.err[1]).toContain('혹시 `up`?');
    expect(await h.run('sound tset up')).toBe(1);
    expect(h.err[2]).toContain('혹시 `test`?');
    expect(await h.run('sound')).toBe(1);
    expect(await h.run('sound on now')).toBe(1);
    expect(await h.run('sound off up')).toBe(1);
    expect(await h.run('test up down')).toBe(1);
    expect(h.err.every((m) => m.includes('예'))).toBe(true);
    expect(h.calls).toEqual([]);
    expect((await h.deps.store.loadConfig()).soundEnabled).toBe(true);
  });

  it('소리 재생 실패는 원인과 해결 방법을 담아 종료 코드 1로 알린다', async () => {
    h.failSound.value = true;
    expect(await h.run('sound test up')).toBe(1);
    expect(h.err[0]).toContain('소리를 재생하지 못했습니다(no audio device)');
    expect(h.err[0]).toContain('예: blert sound test up');
  });
});
