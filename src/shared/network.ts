import { BlertError } from './errors.js';

/**
 * 네트워크 요청은 바이낸스 도메인으로만 보낸다 (NFR-SEC-02).
 * 테스트넷은 개발자 전용 환경변수 BLERT_NETWORK=testnet 으로만 켠다 (v0.2 결정 1A):
 * 설정 파일에는 저장하지 않고, 켜져 있으면 눈에 띄게 표시하며, 테스트넷 도메인은 이 모드에서만 허용한다.
 */
export type NetworkMode = 'mainnet' | 'testnet';

export const MAINNET_HOSTS = ['stream.binance.com', 'fstream.binance.com', 'api.binance.com', 'fapi.binance.com', 'ws-api.binance.com'];
// 선물 데모(테스트넷) 주소는 2026-10 공식 문서 기준 (D-48): https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info
export const TESTNET_HOSTS = ['testnet.binance.vision', 'ws-api.testnet.binance.vision', 'demo-fapi.binance.com', 'demo-fstream.binance.com'];

export function allowedHosts(mode: NetworkMode): readonly string[] {
  return mode === 'testnet' ? [...MAINNET_HOSTS, ...TESTNET_HOSTS] : MAINNET_HOSTS;
}

export function isAllowedUrl(url: string, hosts: readonly string[] = MAINNET_HOSTS): boolean {
  try {
    return hosts.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** 환경변수에서 네트워크 모드를 읽는다. testnet 외의 값은 오타로 보고 거부한다. */
export function networkMode(env: Record<string, string | undefined> = process.env): NetworkMode {
  const v = env.BLERT_NETWORK?.trim().toLowerCase();
  if (!v || v === 'mainnet') return 'mainnet';
  if (v === 'testnet') return 'testnet';
  throw new BlertError('err.networkInvalid', { value: env.BLERT_NETWORK ?? '' });
}
