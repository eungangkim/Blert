import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHarness, type Harness } from './helpers.js';
import { FAKE_API_KEY, jsonResponse, makeEd25519, restrictions } from '../security/helpers.js';

let h: Harness;
let pemDir: string;
let pemPath: string;
let pemBody: string;

/** 설정 폴더 안의 모든 파일(로그 포함) 내용을 합친다 */
async function allFilesText(dir: string): Promise<string> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(await readFile(join(entry.parentPath, entry.name), 'utf8'));
  }
  return out.join('\n');
}

beforeEach(async () => {
  h = await makeHarness();
  pemDir = await mkdtemp(join(tmpdir(), 'blert-pem-'));
  const key = makeEd25519();
  pemPath = join(pemDir, 'private_key.pem');
  pemBody = key.pem.split('\n')[1]!;
  await writeFile(pemPath, key.pem);
});
afterEach(async () => {
  await h.cleanup();
  await rm(pemDir, { recursive: true, force: true });
});

const addKey = (hh: Harness) => hh.run('key add');
const withAnswers = async (answers: string[], network?: 'testnet') => {
  const hh = await makeHarness(answers, undefined, network);
  return hh;
};

describe('cli key add / remove (FR-KEY-01)', () => {
  it('AC-26 key add로 키체인에 저장하고 key remove로 삭제하며, 설정 폴더(로그 포함)에 키 흔적이 없다', async () => {
    const hh = await withAnswers([FAKE_API_KEY, pemPath]);
    expect(await addKey(hh)).toBe(0);
    expect(hh.keychain.stored?.apiKey).toBe(FAKE_API_KEY);
    expect(hh.keychain.stored?.privateKeyPem).toContain(pemBody);
    expect((await hh.deps.store.loadConfig()).keyRef).toBe('default'); // 설정 파일에는 참조 이름만

    const files = await allFilesText(hh.dir);
    expect(files).not.toContain(FAKE_API_KEY);
    expect(files).not.toContain(pemBody);
    expect(hh.out.join('\n') + hh.err.join('\n')).not.toContain(FAKE_API_KEY); // 화면에도 다시 보여주지 않는다
    expect(hh.out.join('\n')).toContain('키체인에 저장했습니다');

    expect(await hh.run('key remove')).toBe(0);
    expect(hh.keychain.stored).toBeUndefined();
    expect((await hh.deps.store.loadConfig()).keyRef).toBeUndefined();
    expect(await allFilesText(hh.dir)).not.toContain(FAKE_API_KEY);
    expect(hh.out.at(-1)).toContain('삭제했습니다');
    await hh.cleanup();
  });

  it('AC-26 개인키 원본 파일을 삭제하라고 안내하고, 따옴표로 감싼 경로도 받는다', async () => {
    const hh = await withAnswers([FAKE_API_KEY, `"${pemPath}"`]);
    expect(await addKey(hh)).toBe(0);
    expect(hh.out.join('\n')).toContain(`개인키 원본 파일(${pemPath})`);
    await hh.cleanup();
  });

  it('AC-27 거래·출금 권한이 켜진 키는 저장하지 않고 종료 코드 2로 문제 권한을 안내한다', async () => {
    for (const flags of [{ enableSpotAndMarginTrading: true }, { enableWithdrawals: true }, { enableFutures: true, enableMargin: true }]) {
      const hh = await withAnswers([FAKE_API_KEY, pemPath]);
      hh.setFetch(jsonResponse(restrictions(flags)));
      expect(await addKey(hh)).toBe(2);
      expect(hh.err[0]).toContain('읽기 전용이 아니어서');
      expect(hh.err[0]).toContain(Object.keys(flags).sort()[0]!);
      expect(hh.err[0]).toContain('예:');
      expect(hh.keychain.stored).toBeUndefined();
      expect((await hh.deps.store.loadConfig()).keyRef).toBeUndefined();
      await hh.cleanup();
    }
  });

  it('AC-38 선물 권한(enableFutures)만 켜진 키도 선물 주문이 가능하므로 저장하지 않고 종료 코드 2로 안내한다 (D-53)', async () => {
    const hh = await withAnswers([FAKE_API_KEY, pemPath]);
    hh.setFetch(jsonResponse(restrictions({ enableFutures: true })));
    expect(await addKey(hh)).toBe(2);
    expect(hh.err[0]).toContain('enableFutures');
    expect(hh.err[0]).toContain('읽기 전용이 아니어서');
    expect(hh.keychain.stored).toBeUndefined();
    await hh.cleanup();
  });

  it('AC-28 HMAC 시크릿을 담은 파일은 바이낸스에 요청하기 전에 거부하고 Ed25519 생성 방법을 안내한다', async () => {
    const hmacFile = join(pemDir, 'secret.txt');
    await writeFile(hmacFile, 'x'.repeat(64));
    const hh = await withAnswers([FAKE_API_KEY, hmacFile]);
    expect(await addKey(hh)).toBe(2);
    expect(hh.err[0]).toContain('openssl genpkey -algorithm ED25519');
    expect(hh.fetchCalls()).toBe(0);
    expect(hh.keychain.stored).toBeUndefined();
    await hh.cleanup();
  });

  it('AC-34 키체인이 없는 환경은 키 저장을 거부하고, 공개 알림 명령은 그대로 동작한다', async () => {
    const hh = await withAnswers([FAKE_API_KEY, pemPath]);
    hh.keychain.isAvailable = false;
    expect(await addKey(hh)).toBe(2);
    expect(hh.err[0]).toContain('OS 키체인을 쓸 수 없어');
    expect(hh.err[0]).toContain('파일이나 환경변수로 대신 저장하지 않으며');
    expect(hh.keychain.stored).toBeUndefined();
    expect(await hh.run('add price BTC above 70000')).toBe(0); // 공개 알림은 정상
    expect(await hh.run('list')).toBe(0);
    await hh.cleanup();
  });

  it('AC-29 허용 IP 제한이 없는 읽기 전용 키는 저장하되 경고하고, IP 제한이 있으면 경고하지 않는다', async () => {
    const noIp = await withAnswers([FAKE_API_KEY, pemPath]);
    noIp.setFetch(jsonResponse(restrictions({ ipRestrict: false })));
    expect(await addKey(noIp)).toBe(0);
    expect(noIp.out.join('\n')).toContain('허용 IP 제한이 없습니다');
    expect(noIp.keychain.stored).toBeDefined();

    const withIp = await withAnswers([FAKE_API_KEY, pemPath]);
    expect(await addKey(withIp)).toBe(0);
    expect(withIp.out.join('\n')).not.toContain('허용 IP 제한이 없습니다');
    await noIp.cleanup();
    await withIp.cleanup();
  });

  it('입력 오류: 파일이 없거나 API 키 형식이 이상하거나 입력이 끊기면 종료 코드 1이다', async () => {
    const missing = await withAnswers([FAKE_API_KEY, join(pemDir, 'nope.pem')]);
    expect(await addKey(missing)).toBe(1);
    expect(missing.err[0]).toContain('키 파일을 읽을 수 없습니다');

    const badKey = await withAnswers(['short', pemPath]);
    expect(await addKey(badKey)).toBe(1);
    expect(badKey.err[0]).toContain('API 키가 비어 있거나');

    const eof = await withAnswers([FAKE_API_KEY]); // 경로 입력 전에 끊김
    expect(await addKey(eof)).toBe(1);
    for (const x of [missing, badKey, eof]) {
      expect(x.keychain.stored).toBeUndefined();
      await x.cleanup();
    }
  });

  it('이미 키가 있으면 바꿨다고 알리고, 키가 없을 때 remove는 알려 준다', async () => {
    const hh = await withAnswers([FAKE_API_KEY, pemPath, FAKE_API_KEY, pemPath]);
    expect(await hh.run('key remove')).toBe(0);
    expect(hh.out.at(-1)).toContain('삭제할 키가 없습니다');
    await hh.run('key add');
    expect(hh.out.join('\n')).not.toContain('바꿨습니다');
    await hh.run('key add');
    expect(hh.out.join('\n')).toContain('새 키로 바꿨습니다');
    await hh.cleanup();
  });

  it('키를 지우면 계정 알림이 동작하지 않는다고 알린다', async () => {
    const hh = await withAnswers([FAKE_API_KEY, pemPath]);
    await hh.run('key add');
    await hh.run('add fill all');
    await hh.run('add balance USDT 5%');
    await hh.run('key remove');
    expect(hh.out.at(-1)).toContain('계정 알림 2개는 키가 없어 동작하지 않습니다');
    await hh.cleanup();
  });

  it('key는 하위 명령 오타를 제안하고, 인자가 틀리면 사용법을 안내한다', async () => {
    expect(await h.run('key ad')).toBe(1);
    expect(h.err[0]).toContain('혹시 `add`?');
    expect(await h.run('key')).toBe(1);
    expect(await h.run('key add extra')).toBe(1);
    expect(h.err.every((m) => m.includes('예'))).toBe(true);
  });
});

describe('cli key check (FR-KEY-02, FR-KEY-04)', () => {
  it('저장된 키의 권한을 다시 검사하고, 권한이 바뀌었으면 종료 코드 2다', async () => {
    const hh = await withAnswers([FAKE_API_KEY, pemPath]);
    await hh.run('key add');
    expect(await hh.run('key check')).toBe(0);
    expect(hh.out.at(-1)).toContain('읽기 전용 키입니다');

    hh.setFetch(jsonResponse(restrictions({ enableSpotAndMarginTrading: true })));
    expect(await hh.run('key check')).toBe(2);
    expect(hh.err.at(-1)).toContain('enableSpotAndMarginTrading');
    await hh.cleanup();
  });

  it('저장된 키가 없으면 등록 방법을 안내한다 (종료 코드 1)', async () => {
    expect(await h.run('key check')).toBe(1);
    expect(h.err[0]).toContain('blert key add');
  });
});

describe('cli 테스트넷 모드 (결정 1A, 개발자 전용)', () => {
  it('배너를 보여주고 권한 조회를 건너뛰며, 실서버에서는 이 안내가 나오지 않는다', async () => {
    const test = await withAnswers([FAKE_API_KEY, pemPath], 'testnet');
    expect(await test.run('key add')).toBe(0);
    expect(test.out[0]).toContain('[테스트넷 모드]');
    expect(test.out.join('\n')).toContain('권한 검사를 건너뛰었습니다');
    expect(test.fetchCalls()).toBe(0);
    expect(test.keychain.stored).toBeDefined();
    expect(await test.run('key check')).toBe(0);
    expect(test.out.at(-1)).toContain('권한(읽기 전용 여부)은 확인하지 않았습니다');
    expect(test.out.join('\n')).not.toContain('읽기 전용 키입니다'); // 확인하지 않은 것을 확인했다고 말하지 않는다

    const main = await withAnswers([FAKE_API_KEY, pemPath]);
    await main.run('key add');
    expect(main.out.join('\n')).not.toContain('테스트넷');
    expect(main.fetchCalls()).toBe(1);
    await test.cleanup();
    await main.cleanup();
  });
});

describe('cli add fill / balance (FR-ACC-01~02)', () => {
  it('add fill all은 전체 체결을 이벤트마다 알리는 규칙이고, 심볼은 정규화한다', async () => {
    expect(await h.run('add fill all')).toBe(0);
    expect(await h.run('add fill btc')).toBe(0);
    expect(await h.run('add fill ETHUSDC --sound account --name 체결')).toBe(0);
    const rules = await h.deps.store.loadRules();
    expect(rules.map((r) => [r.type, r.market, r.symbol, r.repeat])).toEqual([
      ['fill', 'spot', '*', { kind: 'each' }],
      ['fill', 'spot', 'BTCUSDT', { kind: 'each' }],
      ['fill', 'spot', 'ETHUSDC', { kind: 'each' }],
    ]);
    expect(rules[2]).toMatchObject({ sound: 'account', name: '체결' });
  });

  it('add balance는 자산과 퍼센트를 받고 기본 쿨다운은 10분이다 (D-27)', async () => {
    expect(await h.run('add balance usdt 5%')).toBe(0);
    expect(await h.run('add balance all 10%')).toBe(0);
    const rules = await h.deps.store.loadRules();
    expect(rules[0]).toMatchObject({ type: 'balance', market: 'spot', symbol: '*', condition: { type: 'balance', asset: 'USDT', pct: 5 }, repeat: { kind: 'cooldown', ms: 600_000 } });
    expect(rules[1]!.condition).toEqual({ type: 'balance', asset: '*', pct: 10 });
  });

  it('입력 오류: 선물 체결 전체, 잘못된 자산·퍼센트, 인자 개수, 반복 정책 변경은 종료 코드 1이다', async () => {
    expect(await h.run('add fill f:all')).toBe(1);
    expect(h.err[0]).toContain('심볼을 지정');
    expect(await h.run('add balance U$DT 5%')).toBe(1);
    expect(await h.run('add balance USDT 5')).toBe(1);
    expect(await h.run('add balance USDT')).toBe(1);
    expect(await h.run('add fill')).toBe(1);
    expect(await h.run('add fill all --mode once')).toBe(1);
    expect(h.err.at(-1)).toContain('반복 정책을 바꿀 수 없습니다');
    expect(await h.run('add balance USDT 5% --mode cooldown:5m')).toBe(1);
    expect(h.err.every((m) => m.includes('예'))).toBe(true);
    expect(await h.deps.store.loadRules()).toHaveLength(0);
  });

  it('키가 없으면 등록 방법을 안내하고, 키를 등록한 뒤에는 안내하지 않는다', async () => {
    const hh = await withAnswers([FAKE_API_KEY, pemPath]);
    await hh.run('add fill all');
    expect(hh.out.join('\n')).toContain('API 키가 있어야 동작합니다');
    await hh.run('key add');
    hh.out.length = 0;
    await hh.run('add balance USDT 5%');
    expect(hh.out.join('\n')).not.toContain('API 키가 있어야 동작합니다');
    await hh.cleanup();
  });

  it('list는 계정 알림을 체결·잔고로 보여주고, 전체는 "전체", 잔고의 심볼 열은 "-"로 표시한다', async () => {
    await h.run('add fill all');
    await h.run('add balance USDT 5%');
    await h.run('add fill BTC');
    await h.run('list');
    const lines = h.out.at(-1)!.split('\n');
    expect(lines[1]).toMatch(/체결.*현물.*전체.*주문 체결.*이벤트마다/);
    expect(lines[2]).toMatch(/잔고.*현물.*-.*USDT ±5%.*쿨다운 10m/);
    expect(lines[3]).toContain('BTCUSDT');
  });

  it('등록 확인 문구에 대상이 자연스럽게 나온다', async () => {
    await h.run('add fill all');
    expect(h.out[0]).toBe('알림 1번을 등록했습니다: 현물 전체 주문 체결 · 이벤트마다');
    await h.run('add balance USDT 5%');
    expect(h.out.find((l) => l.startsWith('알림 2번'))).toBe('알림 2번을 등록했습니다: 현물 USDT ±5% · 쿨다운 10m');
  });
});
