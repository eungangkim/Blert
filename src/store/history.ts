import { promises as fs } from 'node:fs';
import { HISTORY_FLUSH_MS, HISTORY_SCHEMA_VERSION, parseHistoryEntry, sortHistory, type HistoryEntry, type HistoryFile } from '../shared/history.js';
import { atomicWrite } from './jsonfile.js';

/** 읽은 결과. corrupt가 true면 파일은 있지만 읽을 수 없거나 형식이 맞지 않아 비어 있는 것으로 본다 (D-143) */
export interface HistoryRead {
  entries: HistoryEntry[];
  corrupt: boolean;
}

/**
 * history.json을 읽는다 (읽기만 한다). 없으면 비어 있고, 항목 중 형식이 맞지 않는 것은 버린다.
 * 파일 전체를 읽을 수 없거나 최상단 형식이 틀리거나 더 새로운 schemaVersion이면 corrupt로 알린다.
 */
export async function readHistory(path: string): Promise<HistoryRead> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], corrupt: false };
    throw e;
  }
  try {
    const data = JSON.parse(raw) as Partial<HistoryFile> | null;
    if (!data || typeof data !== 'object' || typeof data.schemaVersion !== 'number' || data.schemaVersion > HISTORY_SCHEMA_VERSION || !Array.isArray(data.entries)) {
      return { entries: [], corrupt: true };
    }
    const entries = data.entries.map(parseHistoryEntry).filter((e): e is HistoryEntry => e !== undefined);
    return { entries: sortHistory(entries), corrupt: false };
  } catch {
    return { entries: [], corrupt: true };
  }
}

/** 쓰기: 임시 파일에 쓴 뒤 교체하는 원자적 쓰기 (B8, D-143) */
export function writeHistory(path: string, entries: HistoryEntry[]): Promise<void> {
  const file: HistoryFile = { schemaVersion: HISTORY_SCHEMA_VERSION, entries };
  return atomicWrite(path, JSON.stringify(file, null, 1) + '\n');
}

/** 읽을 수 없는 기록 파일을 `.bak`으로 옮겨 두고 새로 시작한다 (D-143). 원본은 지우지 않는다 */
export async function backupCorrupt(path: string): Promise<void> {
  await fs.rename(path, `${path}.bak`).catch(() => {});
}

export interface HistoryRecorderOptions {
  /** 모인 항목을 파일에 이어 붙인다 (잠금·보관 정책은 Store가 맡는다) */
  append: (entries: HistoryEntry[]) => Promise<void>;
  /** 기록이 켜져 있는가. 쓰기 직전에 읽어 `history off`가 바로 반영된다 (D-145) */
  enabled: () => Promise<boolean>;
  flushMs?: number;
  /** 쓰기 실패 안내. 실패해도 알림은 계속된다 */
  onError?: (e: unknown) => void;
}

/**
 * 알림 기록을 1초 단위로 모아서 한 번에 쓴다 (D-143). `add`는 즉시 돌아와 알림 경로를 늦추지 않는다.
 * 종료할 때는 `flush`로 남은 것을 쓴다.
 */
export class HistoryRecorder {
  private buffer: HistoryEntry[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();

  constructor(private o: HistoryRecorderOptions) {}

  add(entries: HistoryEntry[]): void {
    if (entries.length === 0) return;
    this.buffer.push(...entries);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.o.flushMs ?? HISTORY_FLUSH_MS);
    this.timer.unref?.();
  }

  /** 모인 항목을 지금 쓰고 쓰기가 끝나기를 기다린다 */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.buffer.splice(0);
    // 쓰기는 한 번에 하나씩 순서대로 한다
    this.writing = this.writing.then(async () => {
      if (batch.length === 0) return;
      try {
        if (!(await this.o.enabled())) return; // 꺼져 있으면 모은 것을 버린다
        await this.o.append(batch);
      } catch (e) {
        this.o.onError?.(e);
      }
    });
    return this.writing;
  }
}
