import type { BlertEvent, EventOf } from './events.js';

type Handler<T extends BlertEvent['type']> = (event: EventOf<T>) => void;

export interface BusOptions {
  /** 핸들러가 던진 예외를 받는다 (B10 내부 오류). 없으면 발행한 쪽으로 다시 던진다. */
  onError?: (error: unknown, event: BlertEvent) => void;
}

/** runtime이 만드는 타입 있는 이벤트 버스. 모듈 간 통신은 이것만 쓴다 (B2). */
export class EventBus {
  private handlers = new Map<string, Set<(e: never) => void>>();

  constructor(private opts: BusOptions = {}) {}

  on<T extends BlertEvent['type']>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler as (e: never) => void);
    return () => set.delete(handler as (e: never) => void);
  }

  emit(event: BlertEvent): void {
    for (const h of this.handlers.get(event.type) ?? []) {
      try {
        (h as (e: BlertEvent) => void)(event);
      } catch (e) {
        if (!this.opts.onError) throw e;
        this.opts.onError(e, event); // 한 핸들러의 오류가 다른 핸들러를 막지 않는다
      }
    }
  }
}
