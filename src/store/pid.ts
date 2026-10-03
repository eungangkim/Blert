import { promises as fs } from 'node:fs';
import { atomicWrite } from './jsonfile.js';

export const PID_SCHEMA_VERSION = 1;

/**
 * 실행 잠금 겸 생존 신호 파일(blert.pid). B8의 데몬 PID 파일을 v0.1 포그라운드 실행부터 쓴다.
 * - 이미 실행 중인 blert가 있으면 새 실행을 거부한다
 * - 실행 중에는 heartbeatAt을 주기적으로 갱신하고, 정상 종료하면 파일을 지운다.
 *   파일이 남아 있는데 주인이 죽었다면 비정상 종료(보안 프로그램, 강제 종료, 정전 등)이므로 그 구간을 알린다.
 */
export interface PidFile {
  schemaVersion: number;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  /** 이 잠금을 잡은 실행 모드. 없으면(v0.3 이전 파일) 포그라운드로 본다 (v0.4) */
  mode?: 'foreground' | 'daemon';
}

export type AcquireResult = { ok: true; previous?: PidFile } | { ok: false; holder: PidFile };

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // 있지만 권한이 없는 프로세스
  }
}

export async function readPidFile(path: string): Promise<PidFile | undefined> {
  try {
    const data = JSON.parse(await fs.readFile(path, 'utf8')) as Partial<PidFile>;
    if (typeof data.pid !== 'number' || typeof data.heartbeatAt !== 'string') return undefined;
    return {
      schemaVersion: PID_SCHEMA_VERSION,
      pid: data.pid,
      startedAt: data.startedAt ?? data.heartbeatAt,
      heartbeatAt: data.heartbeatAt,
      ...(data.mode === 'daemon' || data.mode === 'foreground' ? { mode: data.mode } : {}),
    };
  } catch {
    return undefined; // 없거나 깨졌으면 주인이 없는 것으로 본다
  }
}

export const writePidFile = (path: string, file: PidFile): Promise<void> => atomicWrite(path, JSON.stringify(file, null, 2) + '\n');

/**
 * 파일의 주인이 지금 실제로 실행 중인가. 프로세스가 살아 있어도 생존 신호가 staleMs보다 오래 끊겼으면
 * (프로세스 번호가 다른 프로그램에 재사용됐거나 멈춘 경우) 주인이 없는 것으로 본다.
 */
export function holderIsRunning(file: PidFile, nowMs: number, staleMs: number): boolean {
  const age = Math.abs(nowMs - Date.parse(file.heartbeatAt));
  return pidAlive(file.pid) && age <= staleMs;
}
