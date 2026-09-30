const MINUTE = 60_000;

/** 기준 시점 앞뒤로 이 시간보다 오래된 표본은 기준 가격으로 쓰지 않는다 (감시 공백 뒤의 잘못된 비교 방지) */
export const MAX_STALE_MS = 2 * MINUTE;

/** 창 하나당 표본 수의 목표. 창이 길수록 표본 간격을 넓혀 메모리를 아낀다 (24시간 창 = 24초 간격, 약 3,600개). */
export const SAMPLES_PER_WINDOW = 3600;

/** 변동률 창(ms)에 맞는 표본 간격: 최소 1초, 창/3,600 (초 단위로 올림) */
export function bucketFor(windowMs: number): number {
  return Math.max(1000, Math.ceil(windowMs / SAMPLES_PER_WINDOW / 1000) * 1000);
}

/**
 * 롤링 윈도우 변동률(D-24)용 가격 이력. 표본 간격(bucketMs)으로 다운샘플링한다.
 * 간격이 창의 1/3,600이라 기준 가격 오차는 창의 0.03% 이하이고, 24시간 창도 심볼당 약 0.1MB면 된다
 * (1초 간격이면 1.75MB, 30개 심볼에서 힙 52MB — 실측).
 */
export class PriceHistory {
  private ts: number[] = [];
  private px: number[] = [];
  private head = 0;

  constructor(readonly bucketMs = 1000) {}

  add(tsMs: number, price: number): void {
    const bucket = Math.floor(tsMs / this.bucketMs) * this.bucketMs;
    const last = this.ts.length - 1;
    if (last < this.head || bucket > this.ts[last]!) {
      this.ts.push(bucket);
      this.px.push(price);
      return;
    }
    // 같은 초는 덮어쓰고, 더 과거 표본(백필)은 제자리에 끼워 넣는다
    let lo = this.head;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ts[mid]! < bucket) lo = mid + 1;
      else hi = mid;
    }
    if (this.ts[lo] === bucket) this.px[lo] = price;
    else {
      this.ts.splice(lo, 0, bucket);
      this.px.splice(lo, 0, price);
    }
  }

  /** targetMs 이하에서 가장 늦은 표본의 가격. 없거나 너무 오래됐으면 undefined. */
  priceAt(targetMs: number): number | undefined {
    let lo = this.head;
    let hi = this.ts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ts[mid]! <= targetMs) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0 || targetMs - this.ts[found]! > MAX_STALE_MS) return undefined;
    return this.px[found];
  }

  /** minTs 이전 표본을 버리되, 기준 조회를 위해 minTs 이하의 마지막 표본 하나는 남긴다 */
  trim(minTs: number): void {
    while (this.head + 1 < this.ts.length && this.ts[this.head + 1]! <= minTs) this.head++;
    if (this.head > 4096) {
      this.ts.splice(0, this.head);
      this.px.splice(0, this.head);
      this.head = 0;
    }
  }

  get size(): number {
    return this.ts.length - this.head;
  }
}

/** 1분봉 거래대금 저장소 (D-25 거래량 급증용) */
export class MinuteVolumes {
  private byOpen = new Map<number, number>();
  private earliest = Infinity;

  set(openTimeMs: number, quoteVolume: number): void {
    const open = Math.floor(openTimeMs / MINUTE) * MINUTE;
    this.byOpen.set(open, quoteVolume);
    if (open < this.earliest) this.earliest = open;
  }

  /** nowMs가 속한 분을 포함해 최근 minutes개 분의 거래대금 합 */
  sum(nowMs: number, minutes: number): number {
    const nowMin = Math.floor(nowMs / MINUTE) * MINUTE;
    let total = 0;
    for (let i = 0; i < minutes; i++) total += this.byOpen.get(nowMin - i * MINUTE) ?? 0;
    return total;
  }

  /** 최근 minutes개 분을 모두 덮는 데이터가 있는가 (없으면 평균이 실제보다 작게 나와 오탐한다) */
  covers(nowMs: number, minutes: number): boolean {
    const nowMin = Math.floor(nowMs / MINUTE) * MINUTE;
    return this.earliest <= nowMin - (minutes - 1) * MINUTE;
  }

  /** 오래된 분봉을 버린다. earliest는 '관측을 시작한 시점'이라 유지한다 (거래 없는 분이 빠져도 커버 판정이 흔들리지 않게). */
  trim(minTs: number): void {
    for (const open of this.byOpen.keys()) if (open < minTs) this.byOpen.delete(open);
  }
}
