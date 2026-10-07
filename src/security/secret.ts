import { KEYCHAIN_SERVICE, type KeyringModule } from './keychain.js';

/** 외부 채널 토큰이 들어 있는 키체인 항목의 계정 이름 (D-71). API 키 항목(`default`)과 분리해 서로 지워지지 않게 한다. */
export const CHANNEL_SECRET_REF = 'blert-channel-telegram';

/** OS 키체인에 문자열 비밀 하나를 보관한다. 테스트는 가짜 구현으로 한다. */
export interface SecretStore {
  /** 이 환경에서 키체인을 쓸 수 있는가 (D-30) */
  available(): Promise<boolean>;
  load(): Promise<string | undefined>;
  save(secret: string): Promise<void>;
  /** 삭제했으면 true, 저장된 값이 없었으면 false */
  remove(): Promise<boolean>;
}

/**
 * 키체인 구현은 API 키와 같은 @napi-rs/keyring을 쓴다(새 의존성 없음). 환경변수·평문 파일 대체 저장은 제공하지 않는다 (B6, D-71).
 */
export function createNapiSecretStore(
  ref = CHANNEL_SECRET_REF,
  loader: () => Promise<KeyringModule> = () => import('@napi-rs/keyring') as unknown as Promise<KeyringModule>,
): SecretStore {
  const entry = async () => new (await loader()).AsyncEntry(KEYCHAIN_SERVICE, ref);
  return {
    async available() {
      try {
        await (await entry()).getPassword();
        return true;
      } catch {
        return false;
      }
    },
    async load() {
      const raw = await (await entry()).getPassword();
      return raw ? raw : undefined;
    },
    async save(secret) {
      await (await entry()).setPassword(secret);
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
