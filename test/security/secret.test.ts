import { describe, expect, it } from 'vitest';
import { CHANNEL_SECRET_REF, createNapiSecretStore } from '../../src/security/secret.js';
import type { KeyringModule } from '../../src/security/keychain.js';

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

describe('security 채널 비밀 저장 (D-71)', () => {
  it('AC-62 토큰을 API 키 항목(blert/default)과 분리된 blert/blert-channel-telegram 항목에 저장·조회·삭제한다', async () => {
    const { mod, store, made } = fakeModule();
    store.set('blert/default', '{"apiKey":"k","privateKeyPem":"p"}'); // 기존 API 키 항목
    const secrets = createNapiSecretStore(CHANNEL_SECRET_REF, async () => mod);
    expect(await secrets.available()).toBe(true);
    expect(await secrets.load()).toBeUndefined();
    await secrets.save('123456789:token-value');
    expect([...store.keys()].sort()).toEqual(['blert/blert-channel-telegram', 'blert/default']);
    expect(made.every((k) => k === 'blert/blert-channel-telegram')).toBe(true);
    expect(await secrets.load()).toBe('123456789:token-value');
    expect(await secrets.remove()).toBe(true);
    expect(await secrets.remove()).toBe(false);
    expect(store.get('blert/default')).toBeDefined(); // 채널을 지워도 API 키는 그대로
  });

  it('AC-63 키체인을 쓸 수 없는 환경(불러오기 실패·접근 오류)은 available이 false이고 던지지 않는다 (D-30)', async () => {
    expect(await createNapiSecretStore(CHANNEL_SECRET_REF, async () => { throw new Error('no native module'); }).available()).toBe(false);
    const broken: KeyringModule = {
      AsyncEntry: class {
        async getPassword(): Promise<string | null> { throw new Error('Secret Service is not available'); }
        async setPassword() {}
        async deletePassword() { return false; }
      },
    };
    const secrets = createNapiSecretStore(CHANNEL_SECRET_REF, async () => broken);
    expect(await secrets.available()).toBe(false);
    expect(await secrets.remove()).toBe(false);
  });
});
