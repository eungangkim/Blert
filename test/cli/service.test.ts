import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers.js';
import { LOGON_DELAY_SECONDS, TASK_NAME, buildTaskXml, isNpxPath, taskArguments } from '../../src/cli/service.js';
import { iso } from '../../src/shared/clock.js';
import { writePidFile } from '../../src/store/pid.js';
import { join } from 'node:path';

const NODE = 'C:\\node\\node.exe';
const SCRIPT = 'C:\\blert\\dist\\index.js';
let h: Harness;
beforeEach(async () => {
  h = await makeHarness(['y']);
});
afterEach(() => h.cleanup());

const install = async (answer = 'y') => {
  const hh = await makeHarness([answer]);
  return hh;
};

describe('cli service install (FR-RUN-04, D-62~D-66)', () => {
  it('AC-52 등록할 내용을 보여 주고 y를 받으면 로그온 작업을 만든다 (종료 코드 0)', async () => {
    expect(await h.run('service install')).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('Windows 작업 스케줄러에 등록합니다');
    expect(text).toContain('관리자 권한은 필요하지 않습니다');
    expect(text).toContain(`작업 이름: ${TASK_NAME}`);
    expect(text).toContain(`로그인한 뒤 ${LOGON_DELAY_SECONDS}초`);
    expect(text).toContain(`"${NODE}" "${SCRIPT}" start --service`);
    expect(h.out.at(-1)).toContain('자동 시작을 등록했습니다');
    expect(h.svc.task).toMatchObject({ command: NODE, args: `"${SCRIPT}" start --service` });
    expect(h.asked).toEqual(['등록할까요? (y/N) ']);
  });

  it('AC-52 n이거나 빈 입력이면 아무것도 만들지 않는다', async () => {
    for (const answer of ['n', '']) {
      const hh = await install(answer);
      expect(await hh.run('service install')).toBe(0);
      expect(hh.svc.task).toBeUndefined();
      expect(hh.svc.registerCalls).toBe(0);
      expect(hh.out.at(-1)).toContain('등록하지 않았습니다');
      await hh.cleanup();
    }
  });

  it('AC-54 이미 등록돼 있으면 갱신한다고 알리고 같은 작업을 새 내용으로 바꾼다 (중복 등록 없음)', async () => {
    await h.run('service install');
    const hh = await makeHarness(['y']);
    hh.svc.task = { xml: '<old/>', command: 'C:\\old\\node.exe', args: '"C:\\old\\index.js" start --service' };
    expect(await hh.run('service install')).toBe(0);
    expect(hh.out.join('\n')).toContain('새 내용으로 바꿉니다');
    expect(hh.svc.task?.command).toBe(NODE);
    expect(hh.svc.registerCalls).toBe(1);
    await hh.cleanup();
  });

  it('AC-56 지원하지 않는 OS는 거부하고 대안을 안내한다 (종료 코드 1, 묻지 않음)', async () => {
    h.svc.supported = false;
    expect(await h.run('service install')).toBe(1);
    expect(h.err[0]).toContain('Windows만 지원');
    expect(h.err[0]).toContain('blert start');
    expect(h.asked).toEqual([]);
    expect(await h.run('service uninstall')).toBe(1);
  });

  it('AC-56 npx 임시 경로에서는 거부하고 전역 설치를 안내한다', async () => {
    h.svc.scriptPath = 'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1a2b3c\\node_modules\\blert\\dist\\index.js';
    h.svc.files.add(h.svc.scriptPath);
    expect(await h.run('service install')).toBe(1);
    expect(h.err[0]).toContain('npx');
    expect(h.err[0]).toContain('npm install -g @eungang/blert');
    expect(h.svc.registerCalls).toBe(0);
    expect(isNpxPath('/home/u/.npm/_npx/abc/node_modules/blert/dist/index.js')).toBe(true);
    expect(isNpxPath('C:\\blert\\dist\\index.js')).toBe(false);
  });

  it('실행 파일이 없으면 등록하지 않고 알린다', async () => {
    h.svc.files.delete(SCRIPT);
    expect(await h.run('service install')).toBe(1);
    expect(h.err[0]).toContain(SCRIPT);
    expect(h.err[0]).toContain('예:');
    expect(h.svc.registerCalls).toBe(0);
  });

  it('작업 스케줄러가 등록에 실패하면 종료 코드 9와 해결 방법을 보여 준다', async () => {
    h.svc.failRegister = 'schtasks 1';
    expect(await h.run('service install')).toBe(9);
    expect(h.err[0]).toContain('schtasks 1');
    expect(h.err[0]).toContain('예:');
  });

  it('인자가 없거나 틀리면 사용법과 예시를 보여 준다', async () => {
    for (const argv of ['service', 'service remove', 'service install now']) {
      h.err.length = 0;
      expect(await h.run(argv), argv).toBe(1);
      expect(h.err[0]).toContain('blert service install');
    }
  });
});

describe('cli service uninstall (FR-RUN-04)', () => {
  it('AC-53 등록된 작업을 지우고, 실행 중인 데몬은 건드리지 않는다', async () => {
    await h.run('service install');
    await writePidFile(join(h.dir, 'blert.pid'), { schemaVersion: 1, pid: h.sim.pid, startedAt: iso(h.sim.nowMs), heartbeatAt: iso(h.sim.nowMs), mode: 'daemon' });
    h.out.length = 0;
    expect(await h.run('service uninstall')).toBe(0);
    expect(h.svc.task).toBeUndefined();
    expect(h.out[0]).toContain('자동 시작을 해제했습니다');
    expect(h.out[0]).toContain('blert stop');
    expect(h.sim.kills).toEqual([]);
    expect(await h.deps.store.readRunLock()).toMatchObject({ pid: h.sim.pid, mode: 'daemon' });
    expect(await h.deps.store.stopRequested()).toBe(false);
  });

  it('AC-53 이미 없으면 안내만 하고 종료 코드 0이다', async () => {
    expect(await h.run('service uninstall')).toBe(0);
    expect(h.out[0]).toContain('등록된 자동 시작이 없습니다');
  });

  it('해제에 실패하면 종료 코드 9와 직접 삭제하는 방법을 안내한다', async () => {
    await h.run('service install');
    h.svc.failUnregister = 'schtasks 5';
    expect(await h.run('service uninstall')).toBe(9);
    expect(h.err[0]).toContain('schtasks 5');
    expect(h.err[0]).toContain('예:');
  });
});

describe('cli status의 자동 시작 한 줄 (D-65, D-66)', () => {
  it('AC-55 등록되지 않았거나 등록됐으면 한 줄로 알린다', async () => {
    await h.run('status');
    expect(h.out.at(-1)).toContain('자동 시작: 등록되지 않음');
    expect(h.out.at(-1)).toContain('blert service install');
    await h.run('service install');
    h.out.length = 0;
    await h.run('status');
    expect(h.out.at(-1)).toContain('자동 시작: 등록됨');
  });

  it('AC-55 등록한 경로가 사라지면 경로 이상을 경고하고 재설치를 안내한다 (업데이트·이동 후)', async () => {
    await h.run('service install');
    h.svc.files.delete(SCRIPT);
    h.out.length = 0;
    await h.run('status');
    expect(h.out.at(-1)).toContain('등록된 경로를 찾을 수 없습니다');
    expect(h.out.at(-1)).toContain(SCRIPT);
    expect(h.out.at(-1)).toContain('blert service install');
    h.svc.files.add(SCRIPT);
    h.svc.files.delete(NODE); // node가 옮겨진 경우도 같다
    h.out.length = 0;
    await h.run('status');
    expect(h.out.at(-1)).toContain(NODE);
  });

  it('AC-55 데몬 실행 여부와 상관없이 같은 줄이 붙고, 지원하지 않는 OS에서는 줄을 만들지 않는다', async () => {
    await writePidFile(join(h.dir, 'blert.pid'), { schemaVersion: 1, pid: h.sim.pid, startedAt: iso(h.sim.nowMs), heartbeatAt: iso(h.sim.nowMs), mode: 'daemon' });
    await h.run('status');
    expect(h.out.at(-1)).toContain('자동 시작: 등록되지 않음');
    h.out.length = 0;
    h.svc.supported = false;
    await h.run('status');
    expect(h.out.join('\n')).not.toContain('자동 시작');
  });
});

describe('작업 정의 XML (NFR-SEC-01·02, D-64)', () => {
  const xml = buildTaskXml({ user: 'PC\\user', nodePath: NODE, scriptPath: SCRIPT });

  it('AC-59 현재 사용자의 로그온 트리거와 최소 권한이고, 로그인 후 30초 뒤 start --service를 실행한다 (관리자 불필요)', () => {
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>PC\\user</UserId>');
    expect(xml).toContain(`<Delay>PT${LOGON_DELAY_SECONDS}S</Delay>`);
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).not.toContain('HighestAvailable');
    expect(xml).toContain(`<Command>${NODE}</Command>`);
    expect(xml).toContain(`<Arguments>&quot;${SCRIPT}&quot; start --service</Arguments>`);
    expect(taskArguments(SCRIPT)).toBe(`"${SCRIPT}" start --service`);
  });

  it('AC-59 키·시크릿이 없고 새 네트워크 주소도 없다 (XML 식별자 하나뿐)', () => {
    expect(xml).not.toMatch(/api[-_ ]?key|secret|private|PEM|[A-Za-z0-9]{64}/i);
    const urls = [...xml.matchAll(/https?:\/\/[^"<\s]+/g)].map((m) => m[0]);
    expect(urls).toEqual(['http://schemas.microsoft.com/windows/2004/02/mit/task']);
  });

  it('특수문자가 든 경로(&, <, ")도 XML이 깨지지 않게 이스케이프한다', () => {
    const tricky = buildTaskXml({ user: 'PC\\a&b', nodePath: 'C:\\x&y\\node.exe', scriptPath: 'C:\\<d>\\index.js' });
    expect(tricky).toContain('<UserId>PC\\a&amp;b</UserId>');
    expect(tricky).toContain('C:\\x&amp;y\\node.exe');
    expect(tricky).toContain('C:\\&lt;d&gt;\\index.js');
    expect(tricky).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});

describe('cli start --service (D-67, D-68)', () => {
  it('AC-58 데몬이 이미 실행 중이면 서비스 시작은 아무것도 하지 않고 조용히 끝난다 (종료 코드 0)', async () => {
    await writePidFile(join(h.dir, 'blert.pid'), { schemaVersion: 1, pid: h.sim.pid, startedAt: iso(h.sim.nowMs), heartbeatAt: iso(h.sim.nowMs), mode: 'daemon' });
    expect(await h.run('start --service')).toBe(0);
    expect(h.sim.launches).toBe(0);
    expect(h.out).toEqual([]);
    expect(h.err).toEqual([]);
    // 사용자가 직접 실행한 일반 start는 같은 상황에서 거부한다
    expect(await h.run('start')).toBe(1);
  });

  it('AC-58 포그라운드 run이 실행 중이어도 서비스 시작은 조용히 끝난다', async () => {
    await writePidFile(join(h.dir, 'blert.pid'), { schemaVersion: 1, pid: h.sim.pid, startedAt: iso(h.sim.nowMs), heartbeatAt: iso(h.sim.nowMs), mode: 'foreground' });
    expect(await h.run('start --service')).toBe(0);
    expect(h.sim.launches).toBe(0);
  });

  it('서비스 시작은 데몬을 --service로 띄우고, 일반 start는 그렇지 않다', async () => {
    h.sim.onSleep = async () =>
      void (await h.deps.store.writeStatus({ pid: h.sim.pid, state: 'ready', startedAt: iso(h.sim.nowMs), updatedAt: iso(h.sim.nowMs), rules: { spot: 1, futures: 0 }, connections: [] }));
    expect(await h.run('start --service')).toBe(0);
    expect(h.sim.lastLaunchService).toBe(true);
    await h.deps.store.clearStatus(h.sim.pid);
    expect(await h.run('start')).toBe(0);
    expect(h.sim.lastLaunchService).toBe(false);
  });

  it('--service는 다른 명령에서는 쓸 수 없고, daemon-run은 서비스 여부를 데몬 본체에 넘긴다', async () => {
    expect(await h.run('list --service')).toBe(1);
    expect(await h.run('daemon-run --service')).toBe(0);
    expect(h.calls).toContain('daemon:false:true');
  });

  it('--service는 도움말에 나오지 않는다', async () => {
    await h.run('start --help');
    expect(h.out.join('\n')).not.toContain('--service');
  });
});
