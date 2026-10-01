import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { BlertError, ExitCode } from '../shared/errors.js';

/**
 * 요청 서명에 쓰는 자격. 개인키 자체는 이 객체 밖으로 나가지 않고 sign()만 노출한다.
 * binance 모듈은 이 인터페이스만 안다.
 */
export interface Credentials {
  apiKey: string;
  /** payload(UTF-8)를 Ed25519로 서명해 base64로 돌려준다 (바이낸스 문서: request-security) */
  sign(payload: string): string;
}

/** 키체인에 저장하는 값. 키·시크릿은 파일에 저장하지 않는다 (B6) */
export interface StoredKey {
  apiKey: string;
  privateKeyPem: string;
}

/**
 * Ed25519 개인키(PEM)만 받는다 (D-16). HMAC 시크릿 문자열, RSA 키, 공개키 PEM은 모두 거부한다.
 * 거부 메시지에는 키 내용이 들어가지 않는다 (NFR-SEC-01).
 */
export function parseEd25519PrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem.trim());
  } catch {
    throw new BlertError('err.keyNotEd25519', {}, ExitCode.denied);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new BlertError('err.keyNotEd25519', {}, ExitCode.denied);
  return key;
}

export function signEd25519(key: KeyObject, payload: string): string {
  return sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
}

export function credentialsFrom(stored: StoredKey): Credentials {
  const key = parseEd25519PrivateKey(stored.privateKeyPem);
  return { apiKey: stored.apiKey, sign: (payload) => signEd25519(key, payload) };
}

/** 바이낸스 API 키는 영문·숫자 64자다. 길이는 여유를 두고 형식만 확인한다. */
export function isPlausibleApiKey(apiKey: string): boolean {
  return /^[A-Za-z0-9]{32,128}$/.test(apiKey);
}
