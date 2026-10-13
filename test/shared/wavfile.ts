/** 시험용 WAV를 만든다 */
export function makeWav(o: { tag?: number; channels?: number; rate?: number; bits?: number; ms?: number; dataBytes?: number } = {}): Uint8Array {
  const channels = o.channels ?? 1;
  const rate = o.rate ?? 22050;
  const bits = o.bits ?? 16;
  const align = channels * (bits / 8);
  const frames = Math.round(((o.ms ?? 200) / 1000) * rate);
  const dataSize = o.dataBytes ?? frames * align;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(o.tag ?? 1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * align, 28);
  buf.writeUInt16LE(align, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return new Uint8Array(buf);
}
