import type { WebSocketLike } from '../../src/binance/connection.js';

export interface SubMessage {
  method: 'SUBSCRIBE' | 'UNSUBSCRIBE';
  params: string[];
  id: number;
}

/** 바이낸스 결합 스트림 연결을 흉내 내는 가짜 소켓. 서버 쪽 동작은 serverXxx로 일으킨다. */
export class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  readonly sent: SubMessage[] = [];
  readonly subscribed = new Set<string>();
  readonly createdAt = Date.now();
  opened = false;
  closed = false;

  constructor(
    readonly url: string,
    private net: FakeNetwork,
  ) {}

  send(data: string): void {
    if (!this.opened || this.closed) throw new Error('socket is not open');
    const m = JSON.parse(data) as SubMessage;
    this.sent.push(m);
    for (const p of m.params) (m.method === 'SUBSCRIBE' ? this.subscribed.add(p) : this.subscribed.delete(p));
    if (this.net.autoAck) this.ack(m.id);
  }

  close(): void {
    this.closed = true;
  }

  ack(id: number): void {
    queueMicrotask(() => this.serverSend({ result: null, id }));
  }
  serverOpen(): void {
    this.opened = true;
    this.onopen?.({});
  }
  serverSend(obj: unknown): void {
    if (!this.closed) this.onmessage?.({ data: JSON.stringify(obj) });
  }
  serverDrop(): void {
    this.closed = true;
    this.onclose?.({});
  }
}

export class FakeNetwork {
  sockets: FakeSocket[] = [];
  /** true면 새 연결이 곧바로 끊긴다 (서버 다운). 함수면 그 주소에 대해서만 거부한다. */
  refuse: boolean | ((url: string) => boolean) = false;
  /** false면 SUBSCRIBE 응답을 보내지 않는다 */
  autoAck = true;

  factory = (url: string): FakeSocket => {
    const s = new FakeSocket(url, this);
    this.sockets.push(s);
    const refused = typeof this.refuse === 'function' ? this.refuse(url) : this.refuse;
    queueMicrotask(() => (refused ? s.serverDrop() : s.serverOpen()));
    return s;
  };

  get live(): FakeSocket[] {
    return this.sockets.filter((s) => s.opened && !s.closed);
  }

  /** 해당 스트림을 구독한 모든 연결로 결합 스트림 메시지를 보낸다 */
  push(stream: string, data: unknown): void {
    for (const s of this.live) if (s.subscribed.has(stream)) s.serverSend({ stream, data });
  }

  dropAll(): void {
    for (const s of this.live) s.serverDrop();
  }
}

// 바이낸스 페이로드 흉내 (필드명은 src/binance/endpoints.ts의 문서 링크 참고)
export const miniTicker = (s: string, price: number, quoteVolume = 1) => ({
  e: '24hrMiniTicker', E: Date.now(), s, c: String(price), o: '1', h: '1', l: '1', v: '1', q: String(quoteVolume),
});
export const klineMsg = (s: string, openTime: number, close: number, quoteVolume: number, closed = false) => ({
  e: 'kline', E: Date.now(), s, k: { t: openTime, T: openTime + 59_999, s, i: '1m', c: String(close), q: String(quoteVolume), x: closed },
});
export const markPrice = (s: string, rate: number, next: number, mark = '1') => ({
  e: 'markPriceUpdate', E: Date.now(), s, p: mark, i: '1', P: '1', r: String(rate), T: next,
});

/** 시작 시각부터 count개의 1분봉 REST 행 */
export function klineRows(firstOpen: number, count: number, close = 1000, quote = 1000): unknown[][] {
  return Array.from({ length: count }, (_, i) => {
    const open = firstOpen + i * 60_000;
    return [open, '1', '1', '1', String(close), '1', open + 59_999, String(quote), 1, '0', '0', '0'];
  });
}
