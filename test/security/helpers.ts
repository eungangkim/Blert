import { createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { vi } from 'vitest';
import type { Keychain } from '../../src/security/keychain.js';
import type { StoredKey } from '../../src/security/credentials.js';

/** 실행할 때마다 새로 만드는 테스트 전용 키. 어떤 파일에도 저장하지 않는다. */
export function makeEd25519() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey,
    privateKey,
  };
}

/** 키 문자열처럼 보이지만 아무 계정에도 속하지 않는 값 (영문·숫자 64자) */
export const FAKE_API_KEY = 'TESTKEY'.padEnd(64, 'x');

export function verifies(publicKey: KeyObject | string, payload: string, signatureB64: string): boolean {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  return verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
}

export class FakeKeychain implements Keychain {
  stored?: StoredKey;
  isAvailable = true;
  saves = 0;
  async available() {
    return this.isAvailable;
  }
  async load() {
    return this.stored;
  }
  async save(key: StoredKey) {
    this.saves++;
    this.stored = key;
  }
  async remove() {
    const had = this.stored !== undefined;
    this.stored = undefined;
    return had;
  }
}

/** 권한 조회 응답을 흉내 낸다. 기본은 읽기 전용 키. */
export const restrictions = (over: Record<string, unknown> = {}) => ({
  ipRestrict: true,
  createTime: 1_623_840_271_000,
  enableReading: true,
  enableWithdrawals: false,
  enableInternalTransfer: false,
  enableMargin: false,
  enableFutures: false,
  permitsUniversalTransfer: false,
  enableVanillaOptions: false,
  enableFixApiTrade: false,
  enableFixReadOnly: false,
  enableSpotAndMarginTrading: false,
  enablePortfolioMarginTrading: false,
  ...over,
});

export const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

export const mockFetch = (...responses: (Response | Error)[]) => {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r instanceof Error) throw r;
    return r.clone();
  });
};
