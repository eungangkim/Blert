import type { BlertEvent, EventOf } from './events.js';

type Handler<T extends BlertEvent['type']> = (event: EventOf<T>) => void;

/** runtime이 만드는 타입 있는 이벤트 버스. 모듈 간 통신은 이것만 쓴다 (B2). */
export class EventBus {
  private handlers = new Map<string, Set<(e: never) => void>>();

  on<T extends BlertEvent['type']>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler as (e: never) => void);
    return () => set.delete(handler as (e: never) => void);
  }

  emit(event: BlertEvent): void {
    for (const h of this.handlers.get(event.type) ?? []) (h as (e: BlertEvent) => void)(event);
  }
}
