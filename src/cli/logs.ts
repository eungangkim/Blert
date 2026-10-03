import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { BlertError } from '../shared/errors.js';
import { t } from '../i18n/index.js';
import type { Command, Ctx } from './types.js';

const FILE = /^blert-\d{4}-\d{2}-\d{2}\.log$/;
const DEFAULT_LINES = 50;
const FOLLOW_POLL_MS = 500;

function parseLines(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LINES;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1) || n > 100_000) throw new BlertError('err.logsLines', { value: raw });
  return n;
}

/** 가장 최근 로그 파일들에서 마지막 n줄을 모은다 (오늘 로그가 짧으면 전날 것까지 이어서) */
async function tail(dir: string, files: string[], n: number): Promise<string[]> {
  const out: string[] = [];
  for (const name of [...files].reverse()) {
    const lines = (await fs.readFile(join(dir, name), 'utf8')).split('\n').filter((l) => l.length > 0);
    out.unshift(...lines);
    if (out.length >= n) break;
  }
  return out.slice(-n);
}

/** `blert logs [-n 줄 수] [-f]`: 로그를 보여준다. 로거가 이미 키 형태 문자열을 가려서 기록한다 (D-60, NFR-SEC-01) */
export const logsCommand: Command = {
  name: 'logs',
  usageKeys: ['usage.logs'],
  allowedOptions: ['lines', 'follow'],
  async run({ rest, args, deps }: Ctx) {
    if (rest.length > 0) throw new BlertError('err.usage', { usage: t('usage.logs'), example: t('example.logs') });
    const n = parseLines(args.values.get('lines'));
    const dir = deps.store.logsDir;
    const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => FILE.test(f)).sort();
    if (names.length === 0 && !args.flags.has('follow')) {
      deps.io.out(t('logs.none', { dir }));
      return 0;
    }
    if (names.length) for (const line of await tail(dir, names, n)) deps.io.out(line);
    if (!args.flags.has('follow')) return 0;

    // 새 줄을 이어서 보여준다. 하루가 지나 파일이 바뀌면 새 파일의 처음부터 보여준다.
    const signal = deps.interrupt();
    let current = names.at(-1);
    let offset = current ? (await fs.stat(join(dir, current))).size : 0;
    let partial = '';
    while (!signal.aborted) {
      await deps.daemon.sleep(FOLLOW_POLL_MS);
      if (signal.aborted) break;
      const latest = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => FILE.test(f)).sort().at(-1);
      if (!latest) continue;
      if (latest !== current) {
        current = latest;
        offset = 0;
        partial = '';
      }
      const size = (await fs.stat(join(dir, latest)).catch(() => undefined))?.size ?? 0;
      if (size <= offset) continue;
      const handle = await fs.open(join(dir, latest), 'r');
      try {
        const buf = Buffer.alloc(size - offset);
        await handle.read(buf, 0, buf.length, offset);
        offset = size;
        const text = partial + buf.toString('utf8');
        const lines = text.split('\n');
        partial = lines.pop() ?? ''; // 아직 끝나지 않은 줄은 다음에 이어서 보여준다
        for (const l of lines) if (l.length > 0) deps.io.out(l);
      } finally {
        await handle.close();
      }
    }
    return 0;
  },
};
