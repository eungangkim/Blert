import type { Market } from '../shared/types.js';

/*
 * 확인한 공식 문서 (2026-09-30):
 * - 현물 웹소켓 스트림: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
 *   · 엔드포인트 wss://stream.binance.com:9443, 결합 스트림 /stream, 연결 유효 24시간
 *   · 서버가 20초마다 ping, 클라이언트는 60초 안에 pong (Node 내장 WebSocket이 자동 응답)
 *   · 수신 메시지 5개/초(ping·pong·JSON 명령 포함), 연결당 최대 1024 스트림, 심볼은 소문자
 * - 선물(USDⓈ-M) 웹소켓: https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams
 *   · 2026-03 개편으로 /public, /market, /private 라우팅이 필요하다. miniTicker·kline·markPrice는 /market.
 *     (https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Important-WebSocket-Change-Notice)
 *   · 구 URL은 2026-04-23에 폐지된다. 연결 24시간, 서버 ping 3분, 수신 10개/초, 연결당 200 스트림
 * - 현물 klines: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints
 *   · GET /api/v3/klines, limit 기본 500·최대 1000, weight 2, 429/418 + Retry-After
 *   · 응답 배열: 0 시작 시각, 4 종가, 6 종료 시각, 7 quote asset volume
 * - 선물 klines: GET /fapi/v1/klines, limit 기본 500·최대 1500 (응답 배열 형식은 현물과 같다)
 * 문서에서 직접 확인하지 못한 것(실제 연결로 검증 필요): 선물 miniTicker 페이로드 필드(c, q), 선물 klines 세부 형식.
 */
export interface Endpoints {
  ws: Record<Market, string>;
  rest: Record<Market, string>;
}

export const ENDPOINTS: Endpoints = {
  ws: {
    spot: 'wss://stream.binance.com:9443/stream',
    futures: 'wss://fstream.binance.com/market/stream',
  },
  rest: {
    spot: 'https://api.binance.com/api/v3/klines',
    futures: 'https://fapi.binance.com/fapi/v1/klines',
  },
};

/** 연결당 구독 상한(문서 한도보다 조금 낮게)과 klines 1회 최대 개수 */
export const LIMITS: Record<Market, { maxStreams: number; klineLimit: number }> = {
  spot: { maxStreams: 1000, klineLimit: 1000 },
  futures: { maxStreams: 190, klineLimit: 1500 },
};

/** 네트워크 요청은 바이낸스 도메인으로만 보낸다 (NFR-SEC-02) */
export const ALLOWED_HOSTS = ['stream.binance.com', 'fstream.binance.com', 'api.binance.com', 'fapi.binance.com'];

export function isAllowedUrl(url: string, hosts: readonly string[] = ALLOWED_HOSTS): boolean {
  try {
    return hosts.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}
