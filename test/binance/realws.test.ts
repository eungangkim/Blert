import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { BinanceFeed } from '../../src/binance/index.js';
import { ENDPOINTS } from '../../src/binance/endpoints.js';
import { EventBus } from '../../src/shared/bus.js';
import type { BlertEvent } from '../../src/shared/events.js';
import { miniTicker } from './fakeNetwork.js';

/** 이 파일은 실제 Node WebSocket 클라이언트로 붙는다. 상대는 127.0.0.1의 최소 WebSocket 서버(외부 네트워크 없음). */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encode(text: string): Buffer {
  const body = Buffer.from(text);
  const header = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([header, body]);
}

/** 클라이언트(마스킹된) 텍스트 프레임을 해석한다. 닫기 프레임은 null로 표시한다. */
function decode(buf: Buffer): (string | null)[] {
  const out: (string | null)[] = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const opcode = buf[i]! & 0x0f;
    let len = buf[i + 1]! & 0x7f;
    let off = i + 2;
    if (len === 126) {
      len = buf.readUInt16BE(off);
      off += 2;
    }
    const mask = buf.subarray(off, off + 4);
    off += 4;
    const payload = Buffer.from(buf.subarray(off, off + len));
    for (let j = 0; j < payload.length; j++) payload[j] = payload[j]! ^ mask[j % 4]!;
    out.push(opcode === 8 ? null : opcode === 1 ? payload.toString() : '');
    i = off + len;
  }
  return out;
}

interface Conn {
  socket: Duplex;
  received: { method: string; params: string[]; id: number }[];
}

async function startServer(): Promise<{ port: number; conns: Conn[]; close(): void }> {
  const conns: Conn[] = [];
  const server: Server = createServer();
  server.on('upgrade', (req, socket: Duplex) => {
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn: Conn = { socket, received: [] };
    conns.push(conn);
    socket.on('data', (buf: Buffer) => {
      for (const text of decode(buf)) {
        if (text === null) return void socket.end();
        if (!text) continue;
        const msg = JSON.parse(text) as Conn['received'][number];
        conn.received.push(msg);
        socket.write(encode(JSON.stringify({ result: null, id: msg.id })));
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    conns,
    close: () => {
      for (const c of conns) c.socket.destroy();
      server.close();
    },
  };
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
});

describe('binance 실제 WebSocket 클라이언트 연동', () => {
  it('실제 WebSocket으로 붙어 구독하고 시세를 받고, 서버가 끊으면 1초 뒤 다시 붙어 이어 받는다', async () => {
    const server = await startServer();
    const bus = new EventBus();
    const events: BlertEvent[] = [];
    for (const t of ['market.ticker', 'conn.status', 'conn.gap'] as const) bus.on(t, (e) => events.push(e));
    const feed = new BinanceFeed({
      bus,
      endpoints: { ws: { spot: `ws://127.0.0.1:${server.port}/stream`, futures: ENDPOINTS.ws.futures }, rest: ENDPOINTS.rest },
      allowedHosts: ['127.0.0.1'],
    });
    cleanup.push(() => feed.stop(), () => server.close());

    feed.update([{ market: 'spot', symbol: 'BTCUSDT', ticker: true, kline: false, funding: false, backfillMs: 0 }]);
    await waitFor(() => server.conns[0]?.received.length === 1);
    expect(server.conns[0]!.received[0]).toMatchObject({ method: 'SUBSCRIBE', params: ['btcusdt@miniTicker'] });

    server.conns[0]!.socket.write(encode(JSON.stringify({ stream: 'btcusdt@miniTicker', data: miniTicker('BTCUSDT', 70000.5, 1) })));
    await waitFor(() => events.some((e) => e.type === 'market.ticker'));
    expect(events.find((e) => e.type === 'market.ticker')).toMatchObject({ market: 'spot', symbol: 'BTCUSDT', price: 70000.5 });
    expect(events.filter((e) => e.type === 'conn.status').map((e) => e.type === 'conn.status' && e.state)).toContain('open');

    server.conns[0]!.socket.destroy(); // 서버가 연결을 끊음
    await waitFor(() => server.conns.length === 2 && server.conns[1]!.received.length === 1);
    expect(server.conns[1]!.received[0]).toMatchObject({ method: 'SUBSCRIBE', params: ['btcusdt@miniTicker'] });
    await waitFor(() => events.some((e) => e.type === 'conn.gap'));
    expect(events.find((e) => e.type === 'conn.gap')).toMatchObject({ reason: 'disconnect' });
  }, 15_000);

  it('기본 설정은 바이낸스 도메인이 아닌 주소에 연결하지 않는다', async () => {
    const server = await startServer();
    const bus = new EventBus();
    const feed = new BinanceFeed({
      bus,
      endpoints: { ws: { spot: `ws://127.0.0.1:${server.port}/stream`, futures: ENDPOINTS.ws.futures }, rest: ENDPOINTS.rest },
    });
    cleanup.push(() => feed.stop(), () => server.close());
    feed.update([{ market: 'spot', symbol: 'BTCUSDT', ticker: true, kline: false, funding: false, backfillMs: 0 }]);
    await new Promise((r) => setTimeout(r, 300));
    expect(server.conns).toHaveLength(0);
  });
});
