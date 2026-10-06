import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeHarness, type Harness } from './helpers.js';
import { iso } from '../../src/shared/clock.js';
import { writePidFile } from '../../src/store/pid.js';
import { START_WAIT_MS, STOP_WAIT_MS } from '../../src/cli/daemon.js';
import type { StatusFile } from '../../src/store/index.js';

const DEAD_PID = 2_147_483_646;
let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(() => h.cleanup());

const baseStatus = (over: Partial<Omit<StatusFile, 'schemaVersion'>> = {}): Omit<StatusFile, 'schemaVersion'> => ({
  pid: h.sim.pid, state: 'ready', startedAt: iso(h.sim.nowMs), updatedAt: iso(h.sim.nowMs), rules: { spot: 2, futures: 1 },
  connections: [{ stream: 'spot', state: 'open' }, { stream: 'futures-account', state: 'open' }], ...over,
});
const writeLock = (mode: 'daemon' | 'foreground' | undefined, pid = h.sim.pid, ageMs = 0) =>
  writePidFile(join(h.dir, 'blert.pid'), { schemaVersion: 1, pid, startedAt: iso(h.sim.nowMs - 3_600_000), heartbeatAt: iso(h.sim.nowMs - ageMs), ...(mode ? { mode } : {}) });

describe('cli start (FR-RUN-03, D-54, D-58)', () => {
  it('AC-42 데몬을 띄우고 준비 완료를 확인하면 PID를 알리고 즉시 종료 코드 0으로 돌아온다 (분리 실행)', async () => {
    h.sim.onSleep = async () => void (await h.deps.store.writeStatus(baseStatus()));
    expect(await h.run('start')).toBe(0);
    expect(h.sim.launches).toBe(1);
    expect(h.sim.detached).toBe(true);
    expect(h.out.join('\n')).toContain('데몬을 시작했습니다');
    expect(h.out.join('\n')).toContain(`PID ${h.sim.pid}`);
    expect(h.sim.kills).toEqual([]);
  });

  it('AC-45 데몬이 이미 실행 중이면 띄우지 않고 status를 안내한다 (종료 코드 1)', async () => {
    await writeLock('daemon');
    expect(await h.run('start')).toBe(1);
    expect(h.sim.launches).toBe(0);
    expect(h.err[0]).toContain('데몬이 이미 실행 중');
    expect(h.err[0]).toContain('blert status');
  });

  it('AC-45 포그라운드 run이 실행 중이어도 거부한다', async () => {
    await writeLock('foreground');
    expect(await h.run('start')).toBe(1);
    expect(h.sim.launches).toBe(0);
    expect(h.err[0]).toContain('Ctrl+C');
  });

  it('AC-49 데몬이 시작에 실패하면(연결 불가) 이유를 화면에 보여 주고 상태 파일의 종료 코드로 끝나며 상태 파일을 정리한다', async () => {
    h.sim.onSleep = async () =>
      void (await h.deps.store.writeStatus(baseStatus({ state: 'failed', failure: { messageKey: 'err.startConnect', params: { streams: 'spot' }, exitCode: 3 } })));
    expect(await h.run('start')).toBe(3);
    expect(h.err[0]).toContain('연결');
    expect(await h.deps.store.readStatus()).toBeUndefined();
  });

  it('AC-49 고지 미동의로 실패하면 종료 코드 1과 init 안내를 보여 준다', async () => {
    h.sim.onSleep = async () =>
      void (await h.deps.store.writeStatus(baseStatus({ state: 'failed', failure: { messageKey: 'err.runNeedInit', params: {}, exitCode: 1 } })));
    expect(await h.run('start')).toBe(1);
    expect(h.err[0]).toContain('blert init');
  });

  it('AC-49 상태를 남기지 못하고 데몬이 죽으면 종료 코드를 알리고 로그를 안내한다', async () => {
    h.sim.onLaunch = () => h.sim.finish?.(9);
    expect(await h.run('start')).toBe(9);
    expect(h.err[0]).toContain('종료 코드 9');
    expect(h.err[0]).toContain('blert logs');
  });

  it('AC-49 준비되지 않은 채 시간이 지나면 데몬을 강제 종료하고 남기지 않는다', async () => {
    await writeLock(undefined, h.sim.pid, 0).catch(() => {});
    await h.deps.store.releaseRunLock(h.sim.pid); // 이전 잠금 없음
    expect(await h.run('start')).toBe(9);
    expect(h.sim.kills).toEqual([h.sim.pid]);
    expect(h.err[0]).toContain(`${START_WAIT_MS / 1000}초`);
    expect(h.sim.detached).toBe(false);
  });

  it('인자를 받지 않는다', async () => {
    expect(await h.run('start now')).toBe(1);
    expect(h.err[0]).toContain('예:');
  });
});

describe('cli stop (FR-RUN-03, D-57)', () => {
  it('AC-44 종료 요청 파일을 만들고 데몬이 정상 종료할 때까지 기다린다 (종료 코드 0)', async () => {
    await writeLock('daemon');
    let n = 0;
    h.sim.onSleep = async () => {
      if (++n === 3) await h.deps.store.releaseRunLock(h.sim.pid); // 데몬이 요청을 보고 정상 종료
    };
    expect(await h.run('stop')).toBe(0);
    expect(await h.deps.store.stopRequested()).toBe(true);
    expect(h.out.join('\n')).toContain('종료를 요청했습니다');
    expect(h.out.join('\n')).toContain('데몬을 종료했습니다');
    expect(h.sim.kills).toEqual([]);
  });

  it('AC-44 데몬이 10초 안에 응답하지 않으면 강제 종료하고 남은 파일을 정리한 뒤 사실을 알린다', async () => {
    await writeLock('daemon');
    await h.deps.store.writeStatus(baseStatus());
    const start = h.sim.nowMs;
    expect(await h.run('stop')).toBe(0);
    expect(h.sim.nowMs - start).toBeGreaterThanOrEqual(STOP_WAIT_MS);
    expect(h.sim.kills).toEqual([h.sim.pid]);
    expect(h.out.at(-1)).toContain('강제로 종료');
    expect(await h.deps.store.readRunLock()).toBeUndefined();
    expect(await h.deps.store.readStatus()).toBeUndefined();
    expect(await h.deps.store.stopRequested()).toBe(false);
  });

  it('실행 중인 데몬이 없으면 안내하고 종료 코드 0이다', async () => {
    expect(await h.run('stop')).toBe(0);
    expect(h.out[0]).toContain('실행 중인 데몬이 없습니다');
    expect(await h.deps.store.stopRequested()).toBe(false);
  });

  it('AC-48 데몬이 이미 비정상 종료된 상태면 요청을 보내지 않고 알린다', async () => {
    await writeLock('daemon', DEAD_PID, 10 * 60_000);
    expect(await h.run('stop')).toBe(0);
    expect(h.out[0]).toContain('비정상 종료');
    expect(await h.deps.store.stopRequested()).toBe(false);
  });

  it('포그라운드 run은 stop으로 끄지 않고 Ctrl+C를 안내한다 (종료 코드 1)', async () => {
    await writeLock('foreground');
    expect(await h.run('stop')).toBe(1);
    expect(h.err[0]).toContain('Ctrl+C');
    expect(await h.deps.store.stopRequested()).toBe(false);
  });
});

describe('cli status (FR-RUN-03, D-59)', () => {
  it('AC-43 실행 중이 아니면 안내한다', async () => {
    expect(await h.run('status')).toBe(0);
    expect(h.out[0]).toContain('실행 중이 아닙니다');
    expect(h.out[0]).toContain('blert start');
  });

  it('AC-43 데몬이 실행 중이면 PID·시작 시각·규칙 수·연결 상태·최근 감시 중단 구간을 보여 준다', async () => {
    await writeLock('daemon');
    await h.deps.store.writeStatus(baseStatus({ lastGap: { from: iso(h.sim.nowMs - 300_000), to: iso(h.sim.nowMs - 60_000), reason: 'sleep' } }));
    expect(await h.run('status')).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain(`데몬 실행 중 — PID ${h.sim.pid}`);
    expect(text).toMatch(/시작 \d+\/\d+ \d\d:\d\d:\d\d · 마지막 생존/);
    expect(text).toContain('규칙 3개 · 현물 2 · 선물 1');
    expect(text).toContain('연결: spot 열림, futures-account 열림');
    expect(text).toContain('최근 감시 중단');
    expect(text).toContain('절전');
  });

  it('AC-43 시작하는 중(상태 파일이 아직 없음)이면 그렇다고 알린다', async () => {
    await writeLock('daemon');
    expect(await h.run('status')).toBe(0);
    expect(h.out.join('\n')).toContain('시작하는 중');
  });

  it('AC-43 끝나지 않은 감시 중단 구간은 아직 이어지는 중이라고 표시한다', async () => {
    await writeLock('daemon');
    await h.deps.store.writeStatus(baseStatus({ lastGap: { from: iso(h.sim.nowMs - 600_000), to: iso(h.sim.nowMs), reason: 'disconnect', ongoing: true } }));
    await h.run('status');
    expect(h.out.join('\n')).toContain('아직 이어지는 중');
  });

  it('AC-48 데몬이 비정상 종료됐으면 그렇게 알리고 start를 안내한다', async () => {
    await writeLock('daemon', DEAD_PID, 10 * 60_000);
    expect(await h.run('status')).toBe(0);
    expect(h.out[0]).toContain('비정상 종료');
    expect(h.out[0]).toContain('blert start');
  });

  it('포그라운드 run이 실행 중이면 데몬이 아니라고 알린다', async () => {
    await writeLock('foreground');
    await h.run('status');
    expect(h.out[0]).toContain('포그라운드');
  });

  it('생존 신호가 60초 넘게 끊긴 데몬은 프로세스가 살아 있어도 비정상 종료로 본다', async () => {
    await writeLock('daemon', h.sim.pid, 5 * 60_000);
    await h.run('status');
    expect(h.out[0]).toContain('비정상 종료');
  });
});

describe('cli 죽은 데몬 경고 (D-61, NFR-REL-02)', () => {
  it('AC-48 어떤 명령이든 데몬이 비정상 종료된 상태면 한 줄로 경고하고 명령은 그대로 실행한다', async () => {
    await writeLock('daemon', DEAD_PID, 10 * 60_000);
    expect(await h.run('list')).toBe(0);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toContain('데몬이 비정상 종료');
    expect(h.err[0]).toContain('blert start');
    expect(await h.run('add price BTC above 70000')).toBe(0);
    expect(h.err).toHaveLength(2);
  });

  it('AC-48 정상 실행 중이거나 데몬 파일이 없거나 포그라운드 파일이면 경고하지 않는다', async () => {
    await h.run('list');
    await writeLock('daemon');
    await h.run('list');
    await writeLock('foreground', DEAD_PID, 10 * 60_000);
    await h.run('list');
    expect(h.err).toEqual([]);
  });

  it('start·stop·status·run 명령은 자기 방식으로 알리므로 같은 경고를 되풀이하지 않는다', async () => {
    await writeLock('daemon', DEAD_PID, 10 * 60_000);
    await h.run('status');
    await h.run('stop');
    await h.run('run');
    expect(h.err.filter((l) => l.startsWith('경고'))).toEqual([]);
  });
});

describe('cli logs (FR-RUN-03, D-60)', () => {
  const logsDir = () => join(h.dir, 'logs');
  const lines = (from: number, to: number, tag = 'a') => Array.from({ length: to - from + 1 }, (_, i) => `2026-11-01T12:00:${String(from + i).padStart(2, '0')}Z info runtime ${tag}${from + i}`).join('\n') + '\n';

  it('AC-47 로그가 없으면 안내한다', async () => {
    expect(await h.run('logs')).toBe(0);
    expect(h.out[0]).toContain('아직 로그가 없습니다');
  });

  it('AC-47 기본은 최근 로그의 마지막 50줄이고, -n으로 줄 수를 정한다', async () => {
    await mkdir(logsDir(), { recursive: true });
    await writeFile(join(logsDir(), 'blert-2026-11-01.log'), lines(0, 59));
    expect(await h.run('logs')).toBe(0);
    expect(h.out).toHaveLength(50);
    expect(h.out[0]).toContain('a10');
    expect(h.out.at(-1)).toContain('a59');
    h.out.length = 0;
    expect(await h.run('logs -n 3')).toBe(0);
    expect(h.out).toHaveLength(3);
    expect(h.out[0]).toContain('a57');
  });

  it('AC-47 오늘 로그가 짧으면 전날 로그에서 이어서 채운다', async () => {
    await mkdir(logsDir(), { recursive: true });
    await writeFile(join(logsDir(), 'blert-2026-10-31.log'), lines(0, 9, 'old'));
    await writeFile(join(logsDir(), 'blert-2026-11-01.log'), lines(0, 2, 'new'));
    await h.run('logs -n 5');
    expect(h.out.map((l) => l.split(' ').at(-1))).toEqual(['old8', 'old9', 'new0', 'new1', 'new2']);
  });

  it('AC-47 잘못된 줄 수는 종료 코드 1이고 예시를 보여 준다', async () => {
    for (const bad of ['0', 'abc', '-3', '1.5']) {
      h.err.length = 0;
      expect(await h.run(`logs -n ${bad}`), bad).toBe(1);
      expect(h.err[0]).toContain('예:');
    }
    expect(await h.run('logs -n')).toBe(1);
    expect(await h.run('logs extra')).toBe(1);
  });

  it('AC-47 -f는 새로 쓰인 줄을 이어서 보여 주고 Ctrl+C(신호)로 끝난다. 끝나지 않은 줄은 완성되면 보여 준다', async () => {
    await mkdir(logsDir(), { recursive: true });
    const file = join(logsDir(), 'blert-2026-11-01.log');
    await writeFile(file, lines(0, 1));
    let n = 0;
    h.sim.onSleep = async () => {
      n++;
      if (n === 1) await appendFile(file, lines(2, 3));
      if (n === 2) await appendFile(file, 'partial-start ');
      if (n === 3) await appendFile(file, 'partial-end\n');
      if (n === 4) h.sim.abort.abort();
    };
    expect(await h.run('logs -n 1 -f')).toBe(0);
    expect(h.out.map((l) => l.split(' ').at(-1))).toEqual(['a1', 'a2', 'a3', 'partial-end']);
    expect(h.out.at(-1)).toBe('partial-start partial-end');
  });

  it('AC-47 -f 중 날짜가 바뀌어 새 로그 파일이 생기면 새 파일의 처음부터 보여 준다', async () => {
    await mkdir(logsDir(), { recursive: true });
    await writeFile(join(logsDir(), 'blert-2026-11-01.log'), lines(0, 0));
    let n = 0;
    h.sim.onSleep = async () => {
      n++;
      if (n === 1) await writeFile(join(logsDir(), 'blert-2026-11-02.log'), lines(0, 1, 'next'));
      if (n === 2) h.sim.abort.abort();
    };
    await h.run('logs -n 1 --follow');
    expect(h.out.map((l) => l.split(' ').at(-1))).toEqual(['a0', 'next0', 'next1']);
  });

  it('AC-47 로그가 없어도 -f는 기다리다가 새 로그가 생기면 보여 준다', async () => {
    let n = 0;
    h.sim.onSleep = async () => {
      n++;
      if (n === 1) {
        await mkdir(logsDir(), { recursive: true });
        await writeFile(join(logsDir(), 'blert-2026-11-01.log'), lines(0, 0, 'first'));
      }
      if (n === 2) h.sim.abort.abort();
    };
    await h.run('logs -f');
    expect(h.out.map((l) => l.split(' ').at(-1))).toEqual(['first0']);
  });
});

describe('cli 숨김 명령과 옵션', () => {
  it('daemon-run은 도움말·오타 제안에 나오지 않고, 실행하면 데몬 본체를 부른다', async () => {
    await h.run('--help');
    expect(h.out.join('\n')).not.toContain('daemon-run');
    expect(h.out.join('\n')).toContain('start');
    h.out.length = 0;
    await h.run('daemn');
    expect(h.err.join('\n')).not.toContain('daemon-run');
    expect(await h.run('daemon-run')).toBe(0);
    expect(h.calls).toContain('daemon:false:false');
  });

  it('logs의 옵션은 logs에서만 허용된다', async () => {
    expect(await h.run('list -n 3')).toBe(1);
    expect(await h.run('list -f')).toBe(1);
  });
});
