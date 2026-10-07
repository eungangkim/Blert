import { BlertError, ExitCode } from '../shared/errors.js';
import { systemClock, type Clock } from '../shared/clock.js';
import type { NetworkMode } from '../shared/network.js';
import { credentialsFrom, isPlausibleApiKey, parseEd25519PrivateKey, type Credentials, type StoredKey } from './credentials.js';
import type { Keychain } from './keychain.js';
import { fetchRestrictions, type Denial, type RestrictionsResult } from './restrictions.js';

export { createNapiKeychain, DEFAULT_KEY_REF, type Keychain } from './keychain.js';
export { createNapiSecretStore, CHANNEL_SECRET_REF, type SecretStore } from './secret.js';
export { parseEd25519PrivateKey, signEd25519, credentialsFrom, type Credentials, type StoredKey } from './credentials.js';
export { evaluateRestrictions, fetchRestrictions, isKeyRejection, ALLOWED_ENABLED, type Denial, type RestrictionsResult } from './restrictions.js';

/** runtime이 시작할 때와 재연결할 때마다 부르는 키 준비 결과 (FR-KEY-04) */
export type PrepareResult =
  | { state: 'none' }
  | { state: 'no-keychain' }
  /** 거래·출금 등 허용하지 않는 권한이 켜져 있음. 계정 기능을 쓰지 않는다. */
  | { state: 'denied'; reason: 'trade' | 'withdraw'; fields: string[] }
  /** 키·서명·허용 IP를 바이낸스가 거부함 */
  | { state: 'rejected'; detail: string }
  /** 일시적 실패(네트워크 등). 계정 기능을 시작하지 않고 다음 재연결 때 다시 확인한다. */
  | { state: 'unverified'; detail: string }
  | { state: 'ready'; credentials: Credentials; ipRestricted: boolean; checked: boolean };

export interface KeyAddResult {
  /** IP 제한 여부. 권한 검사를 생략한 테스트넷에서는 null */
  ipRestricted: boolean | null;
  checked: boolean;
}

/** cli가 쓰는 키 관리 기능. cli는 security에 의존할 수 있다 (B2). */
export interface KeyService {
  /** PEM 개인키와 API 키를 검사(Ed25519만, 읽기 전용만)한 뒤에만 키체인에 저장한다 */
  add(input: { apiKey: string; privateKeyPem: string }): Promise<KeyAddResult>;
  remove(): Promise<boolean>;
  /** 저장된 키의 권한을 다시 검사한다. 문제가 있으면 BlertError(종료 코드 2). */
  check(): Promise<KeyAddResult>;
  /** 키를 쓸 수 있는 상태인지 (던지지 않는다) */
  prepare(): Promise<PrepareResult>;
  /** 키체인을 열지 않고 저장 여부만 알고 싶을 때는 config.keyRef를 본다 */
}

export interface KeyServiceOptions {
  keychain: Keychain;
  fetchFn?: typeof fetch;
  clock?: Clock;
  mode?: NetworkMode;
}

const names = (denied: Denial[], code: Denial['code']) => denied.filter((d) => d.code === code).flatMap((d) => d.fields).join(', ');

/** 검사 결과를 사용자에게 보일 오류로 바꾼다. 허용되면 그대로 돌려준다. */
function toError(r: RestrictionsResult): BlertError | undefined {
  switch (r.kind) {
    case 'ok':
      return undefined;
    case 'denied': {
      const withdraw = names(r.denied, 'withdraw');
      const trade = names(r.denied, 'trade');
      const noRead = names(r.denied, 'noRead');
      if (withdraw || trade) return new BlertError('err.keyDenied', { fields: [withdraw, trade].filter(Boolean).join(', ') }, ExitCode.denied);
      return new BlertError('err.keyNoRead', { fields: noRead }, ExitCode.denied);
    }
    case 'rejected':
      return new BlertError('err.keyRejected', { detail: r.detail }, ExitCode.denied);
    case 'unreachable':
      return new BlertError('err.keyUnverified', { detail: r.detail }, ExitCode.connection);
  }
}

export function createKeyService(o: KeyServiceOptions): KeyService {
  const clock = o.clock ?? systemClock;
  const mode = o.mode ?? 'mainnet';

  /** 테스트넷은 /sapi가 없어 권한을 조회할 수 없다. 이 모드는 개발자 전용이다 (결정 1A). */
  const inspect = async (creds: Credentials): Promise<RestrictionsResult | 'skipped'> =>
    mode === 'testnet' ? 'skipped' : fetchRestrictions(creds, { fetchFn: o.fetchFn, now: () => clock.now(), mode });

  const verify = async (creds: Credentials): Promise<KeyAddResult> => {
    const r = await inspect(creds);
    if (r === 'skipped') return { ipRestricted: null, checked: false };
    const err = toError(r);
    if (err) throw err;
    return { ipRestricted: (r as Extract<RestrictionsResult, { kind: 'ok' }>).ipRestricted, checked: true };
  };

  return {
    async add({ apiKey, privateKeyPem }) {
      const key = apiKey.trim();
      if (!isPlausibleApiKey(key)) throw new BlertError('err.keyApiKey');
      parseEd25519PrivateKey(privateKeyPem); // Ed25519가 아니면 여기서 거부 (AC-28)
      if (!(await o.keychain.available())) throw new BlertError('err.keyNoKeychain', {}, ExitCode.denied); // AC-34

      const stored: StoredKey = { apiKey: key, privateKeyPem: privateKeyPem.trim() + '\n' };
      const result = await verify(credentialsFrom(stored)); // 권한이 넘으면 저장하기 전에 거부 (AC-27)
      await o.keychain.save(stored);
      return result;
    },

    remove: () => o.keychain.remove(),

    async check() {
      if (!(await o.keychain.available())) throw new BlertError('err.keyNoKeychain', {}, ExitCode.denied);
      const stored = await o.keychain.load();
      if (!stored) throw new BlertError('err.keyNone');
      return verify(credentialsFrom(stored));
    },

    async prepare() {
      if (!(await o.keychain.available())) return { state: 'no-keychain' };
      let stored: StoredKey | undefined;
      try {
        stored = await o.keychain.load();
      } catch {
        return { state: 'unverified', detail: 'keychain read failed' };
      }
      if (!stored) return { state: 'none' };
      let credentials: Credentials;
      try {
        credentials = credentialsFrom(stored);
      } catch {
        return { state: 'rejected', detail: 'stored key is not a valid Ed25519 key' };
      }
      const r = await inspect(credentials);
      if (r === 'skipped') return { state: 'ready', credentials, ipRestricted: true, checked: false };
      switch (r.kind) {
        case 'ok':
          return { state: 'ready', credentials, ipRestricted: r.ipRestricted, checked: true };
        case 'denied': {
          const withdraw = names(r.denied, 'withdraw');
          const fields = r.denied.flatMap((d) => d.fields);
          return { state: 'denied', reason: withdraw ? 'withdraw' : 'trade', fields };
        }
        case 'rejected':
          return { state: 'rejected', detail: r.detail };
        case 'unreachable':
          return { state: 'unverified', detail: r.detail };
      }
    },
  };
}
