import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { credentialsFrom, parseEd25519PrivateKey, signEd25519 } from '../../src/security/credentials.js';
import { evaluateRestrictions, fetchRestrictions } from '../../src/security/restrictions.js';
import { createNapiKeychain, type KeyringModule } from '../../src/security/keychain.js';
import { createKeyService } from '../../src/security/index.js';
import { BlertError } from '../../src/shared/errors.js';
import { FAKE_API_KEY, FakeKeychain, jsonResponse, makeEd25519, mockFetch, restrictions, verifies } from './helpers.js';

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const clock = { now: () => NOW };

describe('security 키 검증 (D-16)', () => {
  it('Ed25519 개인키 PEM을 받아들이고 서명은 공개키로 검증된다', () => {
    const { pem, publicKey } = makeEd25519();
    const key = parseEd25519PrivateKey(pem);
    expect(key.asymmetricKeyType).toBe('ed25519');
    const sig = signEd25519(key, 'apiKey=abc&timestamp=1');
    expect(verifies(publicKey, 'apiKey=abc&timestamp=1', sig)).toBe(true);
    expect(verifies(publicKey, 'apiKey=abc&timestamp=2', sig)).toBe(false);
    expect(credentialsFrom({ apiKey: FAKE_API_KEY, privateKeyPem: pem }).sign('x')).toBe(signEd25519(key, 'x')); // Ed25519 서명은 결정적
  });

  it('AC-28 HMAC 시크릿 문자열, RSA 키, 공개키 PEM, 빈 값은 모두 거부하고 종료 코드 2와 생성 방법을 안내한다', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const pub = makeEd25519().publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const hmacSecret = 'x'.repeat(64);
    for (const bad of [hmacSecret, rsa, pub, '', '-----BEGIN PRIVATE KEY-----\nbroken\n-----END PRIVATE KEY-----']) {
      expect(() => parseEd25519PrivateKey(bad)).toThrowError(BlertError);
      try {
        parseEd25519PrivateKey(bad);
      } catch (e) {
        expect(e).toMatchObject({ messageKey: 'err.keyNotEd25519', exitCode: 2 });
      }
    }
  });
});

describe('security 권한 판정 (결정 3A: 화이트리스트, 실패 시 거부)', () => {
  it('읽기 권한만 켜진 키는 허용하고 IP 제한 여부를 돌려준다', () => {
    expect(evaluateRestrictions(restrictions({ ipRestrict: true }))).toEqual({ kind: 'ok', ipRestricted: true });
    expect(evaluateRestrictions(restrictions({ ipRestrict: false }))).toEqual({ kind: 'ok', ipRestricted: false });
    expect(evaluateRestrictions(restrictions({ enableFixReadOnly: true }))).toMatchObject({ kind: 'ok' }); // 읽기 전용 FIX는 허용
  });

  it('출금 권한은 withdraw로, 그 밖에 켜진 권한은 어떤 것이든 trade로 거부한다', () => {
    expect(evaluateRestrictions(restrictions({ enableWithdrawals: true }))).toEqual({ kind: 'denied', denied: [{ code: 'withdraw', fields: ['enableWithdrawals'] }] });
    for (const flag of ['enableSpotAndMarginTrading', 'enableMargin', 'enableFutures', 'enableInternalTransfer', 'permitsUniversalTransfer', 'enableVanillaOptions', 'enableFixApiTrade', 'enablePortfolioMarginTrading']) {
      expect(evaluateRestrictions(restrictions({ [flag]: true })), flag).toEqual({ kind: 'denied', denied: [{ code: 'trade', fields: [flag] }] });
    }
  });

  it('바이낸스가 새 권한 필드를 추가해도 켜져 있으면 거부한다 (실패 시 거부)', () => {
    expect(evaluateRestrictions(restrictions({ enableSomethingNew: true }))).toEqual({ kind: 'denied', denied: [{ code: 'trade', fields: ['enableSomethingNew'] }] });
  });

  it('출금과 거래가 함께 켜지면 둘 다 알리고, 읽기 권한이 없으면 noRead다', () => {
    const both = evaluateRestrictions(restrictions({ enableWithdrawals: true, enableMargin: true, enableFutures: true }));
    expect(both).toEqual({
      kind: 'denied',
      denied: [{ code: 'withdraw', fields: ['enableWithdrawals'] }, { code: 'trade', fields: ['enableFutures', 'enableMargin'] }],
    });
    expect(evaluateRestrictions(restrictions({ enableReading: false }))).toEqual({ kind: 'denied', denied: [{ code: 'noRead', fields: ['enableReading'] }] });
  });

  it('숫자 같은 비(非)불리언 필드는 무시하고, 응답 형식이 이상하면 허용하지 않고 확인 실패로 본다', () => {
    expect(evaluateRestrictions({ ...restrictions(), createTime: 5, tradingAuthorityExpirationTime: 7 })).toMatchObject({ kind: 'ok' });
    for (const weird of [null, [], 'x', 42, {}, { enableReading: 'yes' }]) {
      expect(evaluateRestrictions(weird)).toMatchObject({ kind: 'unreachable' });
    }
  });
});

describe('security 권한 조회 요청 (REST 서명)', () => {
  it('문서의 방식대로 쿼리를 Ed25519로 서명하고 signature를 마지막에 퍼센트 인코딩해 붙인다', async () => {
    const { pem, publicKey } = makeEd25519();
    const fetchFn = mockFetch(jsonResponse(restrictions()));
    const r = await fetchRestrictions(credentialsFrom({ apiKey: FAKE_API_KEY, privateKeyPem: pem }), { fetchFn: fetchFn as unknown as typeof fetch, now: () => NOW });
    expect(r).toMatchObject({ kind: 'ok' });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.binance.com/sapi/v1/account/apiRestrictions');
    expect((init.headers as Record<string, string>)['X-MBX-APIKEY']).toBe(FAKE_API_KEY);
    const query = url.split('?')[1]!;
    expect(query).toMatch(new RegExp(`^recvWindow=5000&timestamp=${NOW}&signature=`)); // signature가 마지막
    const signed = query.slice(0, query.indexOf('&signature='));
    const signature = decodeURIComponent(query.slice(query.indexOf('&signature=') + '&signature='.length));
    expect(verifies(publicKey, signed, signature)).toBe(true);
    expect(url).not.toContain(pem.slice(30, 60)); // 개인키 내용이 요청에 없다
  });

  it('바이낸스 도메인이 아니면 요청하지 않는다 (NFR-SEC-02)', async () => {
    const { pem } = makeEd25519();
    const fetchFn = mockFetch(jsonResponse(restrictions()));
    const r = await fetchRestrictions(credentialsFrom({ apiKey: FAKE_API_KEY, privateKeyPem: pem }), { fetchFn: fetchFn as unknown as typeof fetch, base: 'https://evil.example.com' });
    expect(r).toMatchObject({ kind: 'unreachable' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('키·서명·IP 거부는 rejected, 시계 오차·요청 한도·서버 오류·네트워크 오류는 unreachable로 구분한다', async () => {
    const { pem } = makeEd25519();
    const creds = credentialsFrom({ apiKey: FAKE_API_KEY, privateKeyPem: pem });
    const run = (res: Response | Error) => fetchRestrictions(creds, { fetchFn: mockFetch(res) as unknown as typeof fetch, now: () => NOW });
    expect(await run(jsonResponse({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }, 401))).toMatchObject({ kind: 'rejected', detail: expect.stringContaining('-2015') });
    expect(await run(jsonResponse({ code: -1022, msg: 'Signature for this request is not valid.' }, 400))).toMatchObject({ kind: 'rejected' });
    expect(await run(jsonResponse({ code: -2014, msg: 'API-key format invalid.' }, 401))).toMatchObject({ kind: 'rejected' });
    expect(await run(jsonResponse({ code: -1021, msg: 'Timestamp outside of the recvWindow.' }, 400))).toMatchObject({ kind: 'unreachable' });
    expect(await run(jsonResponse({ code: -1003, msg: 'Too many requests' }, 429))).toMatchObject({ kind: 'unreachable' });
    expect(await run(jsonResponse({}, 503))).toMatchObject({ kind: 'unreachable' });
    expect(await run(new TypeError('fetch failed'))).toMatchObject({ kind: 'unreachable' });
    expect(await run(new Response('<html>', { status: 200 }))).toMatchObject({ kind: 'unreachable' });
  });

  it('오류 설명에는 API 키와 개인키가 담기지 않는다 (NFR-SEC-01)', async () => {
    const { pem } = makeEd25519();
    const creds = credentialsFrom({ apiKey: FAKE_API_KEY, privateKeyPem: pem });
    const r = await fetchRestrictions(creds, { fetchFn: mockFetch(jsonResponse({ code: -2015, msg: 'Invalid API-key' }, 401)) as unknown as typeof fetch });
    expect(JSON.stringify(r)).not.toContain(FAKE_API_KEY);
    expect(JSON.stringify(r)).not.toContain(pem.split('\n')[1]!);
  });
});

describe('security 키체인 어댑터 (@napi-rs/keyring 감싸기)', () => {
  /** 메모리에 저장하는 가짜 모듈. 실제 키체인은 CI Linux에 없으므로 자동 테스트에서는 쓰지 않는다. */
  function fakeModule() {
    const store = new Map<string, string>();
    const made: string[] = [];
    const mod: KeyringModule = {
      AsyncEntry: class {
        private k: string;
        constructor(service: string, user: string) {
          this.k = `${service}/${user}`;
          made.push(this.k);
        }
        async getPassword() {
          return store.get(this.k) ?? null;
        }
        async setPassword(p: string) {
          store.set(this.k, p);
        }
        async deletePassword() {
          return store.delete(this.k);
        }
      },
    };
    return { mod, store, made };
  }

  it('저장·조회·삭제를 서비스 blert / 참조 이름으로 한다', async () => {
    const { mod, store, made } = fakeModule();
    const kc = createNapiKeychain('default', async () => mod);
    expect(await kc.available()).toBe(true);
    expect(await kc.load()).toBeUndefined();
    await kc.save({ apiKey: FAKE_API_KEY, privateKeyPem: 'PEM' });
    expect([...store.keys()]).toEqual(['blert/default']);
    expect(made.every((k) => k === 'blert/default')).toBe(true);
    expect(await kc.load()).toEqual({ apiKey: FAKE_API_KEY, privateKeyPem: 'PEM' });
    expect(await kc.remove()).toBe(true);
    expect(await kc.remove()).toBe(false);
    expect(await kc.load()).toBeUndefined();
  });

  it('AC-34 키체인을 쓸 수 없는 환경(불러오기 실패·접근 오류)은 available이 false다', async () => {
    expect(await createNapiKeychain('default', async () => { throw new Error('no native module'); }).available()).toBe(false);
    const broken: KeyringModule = {
      AsyncEntry: class {
        async getPassword(): Promise<string | null> { throw new Error('Secret Service is not available'); }
        async setPassword() {}
        async deletePassword() { return false; }
      },
    };
    const kc = createNapiKeychain('default', async () => broken);
    expect(await kc.available()).toBe(false);
    expect(await kc.remove()).toBe(false); // 던지지 않는다
  });

  it('형식이 깨진 저장 값은 없는 것으로 본다', async () => {
    const { mod, store } = fakeModule();
    store.set('blert/default', '{ not json');
    expect(await createNapiKeychain('default', async () => mod).load()).toBeUndefined();
    store.set('blert/default', JSON.stringify({ apiKey: 1 }));
    expect(await createNapiKeychain('default', async () => mod).load()).toBeUndefined();
  });
});

describe('security KeyService (FR-KEY-01~04)', () => {
  const setup = (opts: { mode?: 'mainnet' | 'testnet'; available?: boolean } = {}, ...responses: (Response | Error)[]) => {
    const keychain = new FakeKeychain();
    keychain.isAvailable = opts.available ?? true;
    const fetchFn = mockFetch(...(responses.length ? responses : [jsonResponse(restrictions())]));
    const service = createKeyService({ keychain, fetchFn: fetchFn as unknown as typeof fetch, clock, mode: opts.mode });
    return { keychain, fetchFn, service, key: makeEd25519() };
  };
  const thrown = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as BlertError;
    }
    throw new Error('expected rejection');
  };

  it('AC-26 읽기 전용 키는 검사 후 키체인에 저장되고, remove하면 삭제된다', async () => {
    const { service, keychain, key } = setup();
    expect(await service.add({ apiKey: `  ${FAKE_API_KEY}  `, privateKeyPem: key.pem })).toEqual({ ipRestricted: true, checked: true });
    expect(keychain.stored?.apiKey).toBe(FAKE_API_KEY); // 공백은 정리
    expect(keychain.stored?.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(await service.remove()).toBe(true);
    expect(keychain.stored).toBeUndefined();
    expect(await service.remove()).toBe(false);
  });

  it('AC-27 거래 권한이 켜진 키는 저장하지 않고 종료 코드 2로 문제 권한을 안내한다', async () => {
    const { service, keychain, key } = setup({}, jsonResponse(restrictions({ enableSpotAndMarginTrading: true, enableMargin: true })));
    const e = await thrown(service.add({ apiKey: FAKE_API_KEY, privateKeyPem: key.pem }));
    expect(e).toMatchObject({ messageKey: 'err.keyDenied', exitCode: 2, params: { fields: 'enableMargin, enableSpotAndMarginTrading' } });
    expect(keychain.saves).toBe(0);
  });

  it('AC-27 출금 권한이 켜진 키도 저장하지 않는다', async () => {
    const { service, keychain, key } = setup({}, jsonResponse(restrictions({ enableWithdrawals: true })));
    expect(await thrown(service.add({ apiKey: FAKE_API_KEY, privateKeyPem: key.pem }))).toMatchObject({ messageKey: 'err.keyDenied', exitCode: 2, params: { fields: 'enableWithdrawals' } });
    expect(keychain.saves).toBe(0);
  });

  it('읽기 권한이 없는 키는 거부한다', async () => {
    const { service, key } = setup({}, jsonResponse(restrictions({ enableReading: false })));
    expect(await thrown(service.add({ apiKey: FAKE_API_KEY, privateKeyPem: key.pem }))).toMatchObject({ messageKey: 'err.keyNoRead', exitCode: 2 });
  });

  it('AC-28 HMAC 키는 바이낸스에 요청하기 전에 거부한다', async () => {
    const { service, keychain, fetchFn } = setup();
    expect(await thrown(service.add({ apiKey: FAKE_API_KEY, privateKeyPem: 'y'.repeat(64) }))).toMatchObject({ messageKey: 'err.keyNotEd25519', exitCode: 2 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(keychain.saves).toBe(0);
  });

  it('AC-34 키체인이 없는 환경은 저장을 거부하고 대체 저장을 제공하지 않는다', async () => {
    const { service, keychain, fetchFn, key } = setup({ available: false });
    expect(await thrown(service.add({ apiKey: FAKE_API_KEY, privateKeyPem: key.pem }))).toMatchObject({ messageKey: 'err.keyNoKeychain', exitCode: 2 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(keychain.saves).toBe(0);
    expect(await service.prepare()).toEqual({ state: 'no-keychain' });
  });

  it('API 키 형식이 이상하면 종료 코드 1이다', async () => {
    const { service, key } = setup();
    for (const bad of ['', 'short', 'has space '.repeat(8), '키'.repeat(40)]) {
      expect(await thrown(service.add({ apiKey: bad, privateKeyPem: key.pem }))).toMatchObject({ messageKey: 'err.keyApiKey', exitCode: 1 });
    }
  });

  it('바이낸스가 키를 거부하면 종료 코드 2, 확인할 수 없으면 3이고 둘 다 저장하지 않는다', async () => {
    const rejected = setup({}, jsonResponse({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }, 401));
    expect(await thrown(rejected.service.add({ apiKey: FAKE_API_KEY, privateKeyPem: rejected.key.pem }))).toMatchObject({ messageKey: 'err.keyRejected', exitCode: 2 });
    const down = setup({}, new TypeError('fetch failed'));
    expect(await thrown(down.service.add({ apiKey: FAKE_API_KEY, privateKeyPem: down.key.pem }))).toMatchObject({ messageKey: 'err.keyUnverified', exitCode: 3 });
    expect(rejected.keychain.saves + down.keychain.saves).toBe(0);
  });

  it('오류에는 키 내용이 담기지 않는다 (NFR-SEC-01)', async () => {
    const { service, key } = setup({}, jsonResponse(restrictions({ enableWithdrawals: true })));
    const e = await thrown(service.add({ apiKey: FAKE_API_KEY, privateKeyPem: key.pem }));
    const dump = JSON.stringify({ k: e.messageKey, p: e.params });
    expect(dump).not.toContain(FAKE_API_KEY);
    expect(dump).not.toContain(key.pem.split('\n')[1]!);
  });

  it('테스트넷 모드는 /sapi가 없어 권한을 조회하지 않고 검사를 생략했다고 알린다 (결정 1A)', async () => {
    const { service, keychain, fetchFn, key } = setup({ mode: 'testnet' });
    expect(await service.add({ apiKey: FAKE_API_KEY, privateKeyPem: key.pem })).toEqual({ ipRestricted: null, checked: false });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(keychain.stored).toBeDefined();
    expect(await service.prepare()).toMatchObject({ state: 'ready', checked: false });
  });

  it('check는 저장된 키를 다시 검사하고, 권한이 바뀌었으면 종료 코드 2다', async () => {
    const ok = setup({}, jsonResponse(restrictions({ ipRestrict: false })));
    await ok.service.add({ apiKey: FAKE_API_KEY, privateKeyPem: ok.key.pem });
    expect(await ok.service.check()).toEqual({ ipRestricted: false, checked: true });

    const changed = setup({}, jsonResponse(restrictions()), jsonResponse(restrictions({ enableSpotAndMarginTrading: true })));
    await changed.service.add({ apiKey: FAKE_API_KEY, privateKeyPem: changed.key.pem });
    expect(await thrown(changed.service.check())).toMatchObject({ messageKey: 'err.keyDenied', exitCode: 2 });

    expect(await thrown(setup().service.check())).toMatchObject({ messageKey: 'err.keyNone', exitCode: 1 });
  });

  it('prepare는 던지지 않고 상태를 돌려준다 (FR-KEY-04)', async () => {
    const none = setup();
    expect(await none.service.prepare()).toEqual({ state: 'none' });

    const s = setup({}, jsonResponse(restrictions({ ipRestrict: false })));
    await s.service.add({ apiKey: FAKE_API_KEY, privateKeyPem: s.key.pem });
    const ready = await s.service.prepare();
    expect(ready).toMatchObject({ state: 'ready', ipRestricted: false, checked: true });
    expect(ready.state === 'ready' && ready.credentials.apiKey).toBe(FAKE_API_KEY);

    const withdraw = setup({}, jsonResponse(restrictions()), jsonResponse(restrictions({ enableWithdrawals: true, enableMargin: true })));
    await withdraw.service.add({ apiKey: FAKE_API_KEY, privateKeyPem: withdraw.key.pem });
    expect(await withdraw.service.prepare()).toEqual({ state: 'denied', reason: 'withdraw', fields: ['enableWithdrawals', 'enableMargin'] });

    const trade = setup({}, jsonResponse(restrictions()), jsonResponse(restrictions({ enableFutures: true })));
    await trade.service.add({ apiKey: FAKE_API_KEY, privateKeyPem: trade.key.pem });
    expect(await trade.service.prepare()).toMatchObject({ state: 'denied', reason: 'trade' });

    const rej = setup({}, jsonResponse(restrictions()), jsonResponse({ code: -2015, msg: 'x' }, 401));
    await rej.service.add({ apiKey: FAKE_API_KEY, privateKeyPem: rej.key.pem });
    expect(await rej.service.prepare()).toMatchObject({ state: 'rejected' });

    const flaky = setup({}, jsonResponse(restrictions()), new TypeError('fetch failed'));
    await flaky.service.add({ apiKey: FAKE_API_KEY, privateKeyPem: flaky.key.pem });
    expect(await flaky.service.prepare()).toMatchObject({ state: 'unverified' });
  });

  it('저장된 키가 깨졌으면 rejected로 본다', async () => {
    const { service, keychain } = setup();
    keychain.stored = { apiKey: FAKE_API_KEY, privateKeyPem: 'not a key' };
    expect(await service.prepare()).toMatchObject({ state: 'rejected' });
  });
});
