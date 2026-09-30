/** 시간은 주입 가능한 시계로만 다룬다. 테스트에서 실제로 기다리지 않기 위함. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class FakeClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(t: number): void {
    this.t = t;
  }
}

export const iso = (ms: number): string => new Date(ms).toISOString();
