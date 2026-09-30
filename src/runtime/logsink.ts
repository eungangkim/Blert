import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../shared/clock.js';
import type { LogSink } from '../shared/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FILE = /^blert-(\d{4}-\d{2}-\d{2})\.log$/;

/** 하루 한 파일(UTC 날짜)로 로그를 남긴다. 보관은 7일 또는 10MB 중 먼저 도달하는 기준으로 오래된 것부터 지운다 (B8). */
export class FileLogSink implements LogSink {
  private day = '';

  constructor(
    private dir: string,
    private clock: Clock,
    private maxAgeMs = 7 * DAY_MS,
    private maxBytes = 10 * 1024 * 1024,
  ) {}

  write(line: string): void {
    try {
      const day = new Date(this.clock.now()).toISOString().slice(0, 10);
      if (day !== this.day) {
        this.day = day;
        mkdirSync(this.dir, { recursive: true });
        this.prune();
      }
      appendFileSync(join(this.dir, `blert-${day}.log`), line + '\n');
    } catch {
      // 로그를 못 써도 감시는 계속한다
    }
  }

  prune(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => FILE.test(n)).sort();
    } catch {
      return;
    }
    const now = this.clock.now();
    const keep: { name: string; size: number }[] = [];
    for (const name of names) {
      const day = FILE.exec(name)![1]!;
      if (now - Date.parse(day) > this.maxAgeMs) this.remove(name);
      else keep.push({ name, size: statSync(join(this.dir, name)).size });
    }
    let total = keep.reduce((sum, f) => sum + f.size, 0);
    while (total > this.maxBytes && keep.length > 1) {
      const oldest = keep.shift()!;
      total -= oldest.size;
      this.remove(oldest.name);
    }
  }

  private remove(name: string): void {
    try {
      unlinkSync(join(this.dir, name));
    } catch {
      // 다른 프로세스가 이미 지웠을 수 있다
    }
  }
}
