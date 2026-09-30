import type { Clock } from '../shared/clock.js';

/** B9: 15초마다 시계를 확인해 직전 확인보다 60초 이상 흘렀으면 절전 복귀로 판단한다 */
export const SLEEP_CHECK_MS = 15_000;
export const SLEEP_THRESHOLD_MS = 60_000;

export interface SleepDetectorOptions {
  clock: Clock;
  /** 절전이 끝난 것으로 판단되면 감시가 멈췄던 [from, to] (ms)와 함께 호출된다 */
  onWake: (fromMs: number, toMs: number) => void;
  checkMs?: number;
  thresholdMs?: number;
}

/**
 * 절전·최대 절전에서는 타이머도 멈추므로, 깨어난 뒤 첫 확인에서 시계가 크게 건너뛴 것으로 보인다.
 * 직전 확인 시각이 '마지막으로 감시하던 시각'이다.
 */
export class SleepDetector {
  private last = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(private opts: SleepDetectorOptions) {}

  start(): void {
    this.running = true;
    this.last = this.opts.clock.now();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.check(), this.opts.checkMs ?? SLEEP_CHECK_MS);
  }

  private check(): void {
    if (!this.running) return;
    const now = this.opts.clock.now();
    const from = this.last;
    this.last = now;
    try {
      if (now - from >= (this.opts.thresholdMs ?? SLEEP_THRESHOLD_MS)) this.opts.onWake(from, now);
    } finally {
      if (this.running) this.schedule();
    }
  }
}
