import { promises as fs } from 'node:fs';
import { BlertError, ExitCode } from '../shared/errors.js';

export interface LockOptions {
  timeoutMs?: number;
  retryMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function isStale(path: string): Promise<boolean> {
  try {
    const text = await fs.readFile(path, 'utf8');
    const pid = Number.parseInt(text, 10);
    if (Number.isFinite(pid)) return !pidAlive(pid);
    // 만든 직후 pid를 쓰기 전일 수 있으니, 오래된 빈 파일만 죽은 잠금으로 본다
    const st = await fs.stat(path);
    return Date.now() - st.mtimeMs > 10_000;
  } catch {
    return false;
  }
}

/** 파일 잠금으로 CLI와 데몬의 동시 쓰기를 막는다 (B8). */
export async function withLock<T>(lockPath: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const retryMs = opts.retryMs ?? 25;
  const start = Date.now();
  for (;;) {
    try {
      const h = await fs.open(lockPath, 'wx');
      await h.writeFile(String(process.pid));
      await h.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (await isStale(lockPath)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new BlertError('store.lockTimeout', {}, ExitCode.internal);
      await sleep(retryMs);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}
