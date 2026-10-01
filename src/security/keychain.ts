import type { StoredKey } from './credentials.js';

/** OS 키체인 접근. 테스트는 가짜 구현으로 하고, 실제 구현은 아래 createNapiKeychain이다. */
export interface Keychain {
  /** 이 환경에서 키체인을 쓸 수 있는가 (일부 Linux는 Secret Service가 없다, D-30) */
  available(): Promise<boolean>;
  load(): Promise<StoredKey | undefined>;
  save(key: StoredKey): Promise<void>;
  /** 삭제했으면 true, 저장된 키가 없었으면 false */
  remove(): Promise<boolean>;
}

/** 키체인에 저장하는 항목의 서비스·계정 이름. config.json에는 이 참조 이름(keyRef)만 남긴다. */
export const KEYCHAIN_SERVICE = 'blert';
export const DEFAULT_KEY_REF = 'default';

interface EntryLike {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
export interface KeyringModule {
  AsyncEntry: new (service: string, username: string) => EntryLike;
}

/**
 * @napi-rs/keyring(MIT, 버전 고정)으로 Windows 자격 증명 관리자·macOS 키체인·Linux Secret Service를 쓴다.
 * 모듈은 처음 쓸 때 불러온다: 지원하지 않는 환경이거나 불러오지 못하면 available()이 false가 된다.
 * 환경변수·평문 파일로의 대체 저장은 제공하지 않는다 (B6).
 */
export function createNapiKeychain(
  ref = DEFAULT_KEY_REF,
  loader: () => Promise<KeyringModule> = () => import('@napi-rs/keyring') as unknown as Promise<KeyringModule>,
): Keychain {
  const entry = async (): Promise<EntryLike> => new (await loader()).AsyncEntry(KEYCHAIN_SERVICE, ref);

  return {
    async available() {
      try {
        await (await entry()).getPassword(); // 없는 항목이면 null이어야 한다. 키체인이 없으면 여기서 던진다.
        return true;
      } catch {
        return false;
      }
    },

    async load() {
      const raw = await (await entry()).getPassword();
      if (!raw) return undefined;
      try {
        const v = JSON.parse(raw) as Partial<StoredKey>;
        return typeof v.apiKey === 'string' && typeof v.privateKeyPem === 'string' ? { apiKey: v.apiKey, privateKeyPem: v.privateKeyPem } : undefined;
      } catch {
        return undefined; // 형식이 깨진 항목은 없는 것으로 본다 (key add로 덮어쓴다)
      }
    },

    async save(key) {
      await (await entry()).setPassword(JSON.stringify({ apiKey: key.apiKey, privateKeyPem: key.privateKeyPem }));
    },

    async remove() {
      try {
        return await (await entry()).deletePassword();
      } catch {
        return false;
      }
    },
  };
}
