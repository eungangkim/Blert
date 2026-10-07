import { afterEach, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeHarness, type Harness } from './helpers.js';
import { CHAT_WAIT_MS } from '../../src/cli/channel.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** 동의, 토큰, (대화 확인), 계정 알림 포함 여부 순서의 입력 */
const answers = (over: { agree?: string; token?: string; useChat?: string; account?: string; chatId?: string } = {}) => [
  over.agree ?? 'y', over.token ?? TOKEN, ...(over.useChat === undefined ? ['y'] : [over.useChat]), ...(over.chatId === undefined ? [] : [over.chatId]), over.account ?? 'n',
];

/** 설정 폴더의 모든 파일(로그 포함) 내용을 합친다 */
async function allFilesText(dir: string): Promise<string> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (entry.isFile()) out.push(await readFile(join(entry.parentPath, entry.name), 'utf8'));
  }
  return out.join('\n');
}

describe('cli channel add telegram (FR-NOTI-03, D-69~D-72)', () => {
  it('AC-62 고지 → 동의 → 토큰 → 대화 자동 탐지 → 계정 알림 여부 → 시험 메시지 → 저장 (토큰은 키체인에만)', async () => {
    h = await makeHarness(answers());
    expect(await h.run('channel add telegram')).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('기본으로 꺼져 있고');
    expect(text).toContain('텔레그램 서버를 거쳐');
    expect(text).toContain('API 키와 개인키는 어떤 경우에도 보내지 않습니다');
    expect(text).toContain('대화를 찾았습니다: 철수');
    expect(text).toContain('텔레그램 채널을 등록했습니다');
    expect(h.ch.sent).toEqual([{ chatId: '777', text: expect.stringContaining('연결 시험'), token: TOKEN }]);
    expect(h.ch.token).toBe(TOKEN);
    expect((await h.deps.store.loadConfig()).channels).toEqual([{ type: 'telegram', chatId: '777', includeAccount: false }]);
    // 토큰은 설정 폴더(설정·로그)에도 화면에도 남지 않는다 (AC-69)
    expect(await allFilesText(h.dir)).not.toContain(TOKEN);
    expect(text).not.toContain(TOKEN);
    expect(h.err.join('\n')).not.toContain(TOKEN);
    expect(h.asked).toHaveLength(4);
    expect(h.asked.map((q) => ['위 내용에 동의하고', '텔레그램 봇 토큰', '이 대화로 알림을', '체결·잔고·청산가'].some((p) => q.startsWith(p)))).toEqual([true, true, true, true]);
  });

  it('AC-65 계정 알림 포함을 y로 답하면 포함 상태로 저장하고 안내한다', async () => {
    h = await makeHarness(answers({ account: 'y' }));
    expect(await h.run('channel add telegram')).toBe(0);
    expect((await h.deps.store.loadConfig()).channels?.[0]?.includeAccount).toBe(true);
    expect(h.out.at(-1)).toContain('계정 알림도 폰으로 전달됩니다');
  });

  it('AC-63 동의하지 않으면 아무것도 저장·전송하지 않고 종료 코드 1로 끝난다 (토큰은 묻지도 않는다)', async () => {
    for (const no of ['n', '']) {
      const hh = await makeHarness([no]);
      expect(await hh.run('channel add telegram')).toBe(1);
      expect(hh.err[0]).toContain('동의하지 않아');
      expect(hh.err[0]).toContain('예:');
      expect(hh.asked).toHaveLength(1);
      expect(hh.ch.sent).toEqual([]);
      expect(hh.ch.token).toBeUndefined();
      await hh.cleanup();
    }
  });

  it('AC-63 OS 키체인을 쓸 수 없으면 토큰을 받기 전에 거부하고, 파일·환경변수로 대신 저장하지 않는다 (D-30)', async () => {
    h = await makeHarness(['y', TOKEN]);
    h.ch.keychain = false;
    expect(await h.run('channel add telegram')).toBe(1);
    expect(h.err[0]).toContain('OS 키체인을 쓸 수 없어');
    expect(h.err[0]).toContain('파일이나 환경변수로 대신 저장하지 않으며');
    expect(h.asked).toHaveLength(1); // 동의만 물었고 토큰은 묻지 않았다
    expect((await h.deps.store.loadConfig()).channels).toBeUndefined();
    expect(await allFilesText(h.dir)).not.toContain(TOKEN);
  });

  it('토큰 형식이 틀리면 거부하고 예시를 보여 준다 (명령행 인자로 받지 않는다)', async () => {
    h = await makeHarness(answers({ token: 'not-a-token' }));
    expect(await h.run('channel add telegram')).toBe(1);
    expect(h.err[0]).toContain('BotFather');
    expect(h.err[0]).toContain('예:');
    expect(h.ch.listCalls).toBe(0);
    h.err.length = 0;
    expect(await h.run(`channel add telegram ${TOKEN}`)).toBe(1); // 인자로 토큰을 주면 사용법 오류
    expect(h.err[0]).toContain('blert channel add telegram');
  });

  it('텔레그램이 토큰을 거부하면(401) 알리고 저장하지 않는다. 네트워크 오류는 종료 코드 3이다', async () => {
    h = await makeHarness(answers());
    h.ch.listFail = 'rejected';
    expect(await h.run('channel add telegram')).toBe(1);
    expect(h.err[0]).toContain('거부했습니다');
    expect(h.ch.token).toBeUndefined();
    const net = await makeHarness(answers());
    net.ch.listFail = 'network';
    expect(await net.run('channel add telegram')).toBe(3);
    expect(net.err[0]).toContain('연결하지 못했습니다');
    await net.cleanup();
  });

  it('대화 탐지: 메시지가 올 때까지 2초 간격으로 확인하고, 시간이 지나도 없으면 대화 ID를 직접 입력받는다', async () => {
    h = await makeHarness(['y', TOKEN, '12345', 'n']);
    h.ch.chatPolls = [[]]; // 계속 비어 있음
    const start = h.sim.nowMs;
    expect(await h.run('channel add telegram')).toBe(0);
    expect(h.sim.nowMs - start).toBeGreaterThanOrEqual(CHAT_WAIT_MS);
    expect(h.out.join('\n')).toContain('메시지를 찾지 못했습니다');
    expect(h.ch.sent[0]?.chatId).toBe('12345');
    expect((await h.deps.store.loadConfig()).channels?.[0]?.chatId).toBe('12345');

    const late = await makeHarness(answers());
    late.ch.chatPolls = [[], [], [{ chatId: '-100500', name: '가족방' }]]; // 세 번째 확인에서 찾음
    expect(await late.run('channel add telegram')).toBe(0);
    expect(late.ch.listCalls).toBe(3);
    expect((await late.deps.store.loadConfig()).channels?.[0]?.chatId).toBe('-100500');
    await late.cleanup();
  });

  it('찾은 대화가 아니라고 하면(n) 직접 입력받고, 숫자가 아닌 ID는 거부한다', async () => {
    h = await makeHarness(answers({ useChat: 'n', chatId: '-100200' }));
    expect(await h.run('channel add telegram')).toBe(0);
    expect(h.ch.sent[0]?.chatId).toBe('-100200');
    const bad = await makeHarness(['y', TOKEN, 'n', 'da', 'asdaw', 'gsegs']); // 세 번 모두 숫자가 아니면 거부한다
    expect(await bad.run('channel add telegram')).toBe(1);
    expect(bad.out.filter((l) => l.includes('다시 입력하세요'))).toHaveLength(2);
    expect(bad.err[0]).toContain('숫자여야 합니다');
    expect(bad.err[0]).toContain('`gsegs`');
    expect(bad.ch.token).toBeUndefined();
    expect(bad.ch.sent).toEqual([]);
    await bad.cleanup();
  });

  it('대화 ID를 잘못 입력해도 다시 입력할 수 있다 (최대 3번)', async () => {
    h = await makeHarness(['y', TOKEN, 'n', 'da', '-100999', 'n']);
    expect(await h.run('channel add telegram')).toBe(0);
    expect(h.out.filter((l) => l.includes('다시 입력하세요'))).toHaveLength(1);
    expect(h.ch.sent[0]?.chatId).toBe('-100999');
  });

  it('기다리는 동안 터미널에 친 글자는 버리고 다음 질문을 받는다 (잘못 친 글자가 대화 ID 답으로 쓰이던 문제)', async () => {
    h = await makeHarness(['y', TOKEN, '12345', 'n']);
    h.ch.chatPolls = [[]]; // 메시지가 오지 않아 시간이 지남
    expect(await h.run('channel add telegram')).toBe(0);
    expect(h.drainedAt).toEqual([2]); // 동의·토큰 질문 뒤, 대화 ID 질문 앞에서 한 번 버린다
    const found = await makeHarness(answers());
    await found.run('channel add telegram');
    expect(found.drainedAt).toEqual([2]); // 대화를 찾은 경우에도 확인 질문 앞에서 버린다
    await found.cleanup();
  });

  it('안내 문구는 터미널이 아니라 텔레그램 앱에 보내야 한다고 알려 준다', async () => {
    h = await makeHarness(answers());
    await h.run('channel add telegram');
    expect(h.out.join(' ')).toContain('이 터미널이 아니라 텔레그램 앱');
  });

  it('시험 메시지를 보내지 못하면 아무것도 저장하지 않는다 (토큰·설정 모두)', async () => {
    h = await makeHarness(answers());
    h.ch.sendFail = 'unauthorized 401';
    expect(await h.run('channel add telegram')).toBe(1);
    expect(h.err[0]).toContain('unauthorized 401');
    expect(h.err[0]).toContain('아무것도 저장하지 않았습니다');
    expect(h.ch.token).toBeUndefined();
    expect((await h.deps.store.loadConfig()).channels).toBeUndefined();
  });

  it('이미 등록돼 있으면 새 내용으로 바꾼다고 알리고 덮어쓴다 (설정은 하나만)', async () => {
    h = await makeHarness(answers());
    await h.run('channel add telegram');
    const again = await makeHarness(answers({ account: 'y' }));
    await again.deps.store.updateConfig((c) => {
      c.channels = [{ type: 'telegram', chatId: '1', includeAccount: false }];
    });
    expect(await again.run('channel add telegram')).toBe(0);
    expect(again.out.join('\n')).toContain('새 내용으로 바꿉니다');
    expect((await again.deps.store.loadConfig()).channels).toEqual([{ type: 'telegram', chatId: '777', includeAccount: true }]);
    await again.cleanup();
  });

  it('지원하지 않는 채널·인자 오류는 사용법과 예시를 보여 준다', async () => {
    h = await makeHarness();
    for (const argv of ['channel', 'channel add', 'channel add discord', 'channel foo', 'channel remove discord', 'channel add telegram extra']) {
      h.err.length = 0;
      expect(await h.run(argv), argv).toBe(1);
      expect(h.err[0], argv).toContain('예:');
    }
    expect(h.ch.sent).toEqual([]);
  });
});

describe('cli channel remove / test (D-71)', () => {
  it('AC-67 remove는 키체인 토큰과 설정을 지우고, 다시 실행해도 오류 없이 안내한다', async () => {
    h = await makeHarness(answers());
    await h.run('channel add telegram');
    h.out.length = 0;
    expect(await h.run('channel remove')).toBe(0);
    expect(h.ch.token).toBeUndefined();
    expect((await h.deps.store.loadConfig()).channels).toBeUndefined();
    expect(h.out[0]).toContain('해제했습니다');
    h.out.length = 0;
    expect(await h.run('channel remove telegram')).toBe(0);
    expect(h.out[0]).toContain('등록된 외부 채널이 없습니다');
  });

  it('AC-67 remove는 API 키 설정(keyRef)을 건드리지 않는다', async () => {
    h = await makeHarness(answers());
    await h.deps.store.updateConfig((c) => {
      c.keyRef = 'default';
    });
    await h.run('channel add telegram');
    await h.run('channel remove');
    expect((await h.deps.store.loadConfig()).keyRef).toBe('default');
  });

  it('test는 등록된 채널로 시험 메시지를 보내고, 등록이 없으면 안내한다', async () => {
    h = await makeHarness();
    expect(await h.run('channel test')).toBe(1);
    expect(h.err[0]).toContain('먼저 등록하세요');
    const ok = await makeHarness(answers());
    await ok.run('channel add telegram');
    ok.ch.sent.length = 0;
    expect(await ok.run('channel test')).toBe(0);
    expect(ok.ch.sent).toEqual([{ chatId: '777', text: expect.stringContaining('연결 시험'), token: undefined }]); // 저장된 토큰을 쓴다
    expect(ok.out.at(-1)).toContain('폰에서 확인하세요');
    ok.ch.sendFail = 'network';
    expect(await ok.run('channel test telegram')).toBe(1);
    expect(ok.err.at(-1)).toContain('network');
    await ok.cleanup();
  });

  it('test는 설정은 있는데 토큰이 키체인에서 사라졌으면 등록이 없는 것으로 안내한다', async () => {
    h = await makeHarness();
    await h.deps.store.updateConfig((c) => {
      c.channels = [{ type: 'telegram', chatId: '777', includeAccount: false }];
    });
    expect(await h.run('channel test')).toBe(1);
    expect(h.err[0]).toContain('등록된 외부 채널이 없어');
  });

  it('도움말에 channel 명령과 예시가 나온다', async () => {
    h = await makeHarness();
    await h.run('--help');
    expect(h.out.join('\n')).toContain('channel');
    h.out.length = 0;
    await h.run('channel --help');
    expect(h.out.join('\n')).toContain('blert channel add telegram');
  });
});
