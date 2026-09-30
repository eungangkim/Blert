import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BlertError, ExitCode } from '../shared/errors.js';

export type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

export interface FileSpec<T extends { schemaVersion: number }> {
  path: string;
  name: string;
  current: number;
  /** steps[i]는 schemaVersion i+1 → i+2 변환 */
  steps: Migration[];
  defaults: () => T;
}

/** 임시 파일에 쓴 뒤 교체하는 원자적 쓰기 (B8). */
export async function atomicWrite(path: string, text: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export async function readJson<T extends { schemaVersion: number }>(spec: FileSpec<T>): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(spec.path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return spec.defaults();
    throw e;
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new BlertError('store.corrupt', { file: spec.name, path: spec.path }, ExitCode.internal);
  }
  const found = typeof data.schemaVersion === 'number' ? data.schemaVersion : 1;
  if (found > spec.current) {
    throw new BlertError('store.schemaTooNew', { file: spec.name, found }, ExitCode.internal);
  }
  if (found < spec.current) {
    await atomicWrite(`${spec.path}.bak`, raw); // 원본 보관
    for (let v = found; v < spec.current; v++) {
      data = { ...spec.steps[v - 1]!(data), schemaVersion: v + 1 };
    }
    await atomicWrite(spec.path, JSON.stringify(data, null, 2) + '\n');
  }
  return data as unknown as T;
}

export const writeJson = <T extends { schemaVersion: number }>(spec: FileSpec<T>, value: T): Promise<void> =>
  atomicWrite(spec.path, JSON.stringify(value, null, 2) + '\n');
