import type { Market } from '../shared/types.js';
import type { NetworkMode } from '../shared/network.js';

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

/** 네트워크 요청은 바이낸스 도메인으로만 보낸다 (NFR-SEC-02). 목록과 검사는 shared/network.ts에 있다. */
export { MAINNET_HOSTS as ALLOWED_HOSTS, isAllowedUrl } from '../shared/network.js';

/*
 * 계정 연결 (v0.2). 문서 (2026-10-02 확인):
 * - WebSocket API: https://developers.binance.com/docs/binance-spot-api-docs/websocket-api/general-api-information
 *   · wss://ws-api.binance.com:443/ws-api/v3, 테스트넷 wss://ws-api.testnet.binance.vision/ws-api/v3, 연결 24시간, 서버 ping 20초
 *   · 사용자 데이터 이벤트는 {"subscriptionId":0,"event":{...}} 로 온다
 * - 인증: https://developers.binance.com/docs/binance-spot-api-docs/websocket-api/authentication-requests (session.logon, Ed25519 전용)
 *   서명: https://developers.binance.com/docs/binance-spot-api-docs/websocket-api/request-security
 *   · apiKey를 포함한 params(signature 제외)를 이름순 정렬해 key=value&... 로 만들고 Ed25519 서명 후 base64
 * - 구독: https://developers.binance.com/docs/binance-spot-api-docs/websocket-api/user-data-stream-requests (userDataStream.subscribe, listenKey 미사용 — D-06)
 * - 이벤트: https://developers.binance.com/docs/binance-spot-api-docs/user-data-stream
 *   · executionReport(x=TRADE일 때 체결: s 심볼, S 방향, l 체결 수량, L 체결 가격, i 주문 ID, t 체결 ID)
 *   · outboundAccountPosition(B[]: a 자산, f 사용 가능, l 잠김), eventStreamTerminated
 * - REST 서명: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/request-security
 *   · X-MBX-APIKEY 헤더, 쿼리 문자열을 Ed25519로 서명 → base64 → 퍼센트 인코딩 후 signature를 마지막에 붙임
 * - 계정 조회: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/account-endpoints
 *   · GET /api/v3/account (weight 20, balances[].asset/free/locked), GET /api/v3/myTrades (symbol 필수, weight 20, limit 최대 1000)
 * - 권한 조회: https://developers.binance.com/docs/wallet/account/api-key-permission (GET /sapi/v1/account/apiRestrictions, 테스트넷 미지원)
 */
export interface AccountEndpoints {
  wsApi: string;
  rest: string;
}

export const ACCOUNT_ENDPOINTS: Record<NetworkMode, AccountEndpoints> = {
  mainnet: { wsApi: 'wss://ws-api.binance.com:443/ws-api/v3', rest: 'https://api.binance.com' },
  testnet: { wsApi: 'wss://ws-api.testnet.binance.vision/ws-api/v3', rest: 'https://testnet.binance.vision' },
};
