import type { Alert, Rule, RuleState } from '../shared/types.js';
import type { BlertEvent, EventOf } from '../shared/events.js';
import type { EventBus } from '../shared/bus.js';
import type { Logger } from '../shared/logger.js';
import { iso } from '../shared/clock.js';
import type { Store } from '../store/index.js';
import { MinuteVolumes, PriceHistory, MAX_STALE_MS } from './history.js';
import { measureChange, measureFunding, measurePrice, measureVolume, rearmed, satisfied, toAlert, type Measurement } from './measure.js';

const MINUTE = 60_000;
const LOG = 'engine';

type StoreApi = Pick<Store, 'loadRules' | 'loadStates' | 'saveStates' | 'setEnabled'>;

export interface EngineOptions {
  store?: StoreApi;
  logger?: Logger;
}

const keyOf = (market: string, symbol: string) => `${market}:${symbol}`;

/**
 * 시장 이벤트를 규칙과 대조해 발동 여부를 결정한다 (B4).
 * 시간 판단은 모두 이벤트의 ts를 기준으로 한다. 시계는 이벤트를 만드는 쪽(binance)이 주입받는다.
 * 조건이 충족된 상태로 처음 평가되면 곧바로 발동한다 (수준 트리거).
 */
export class Engine {
  private byKey = new Map<string, Rule[]>();
  private states = new Map<number, RuleState>();
  private prices = new Map<string, PriceHistory>();
  private volumes = new Map<string, MinuteVolumes>();
  private priceRetention = new Map<string, number>();
  private volumeRetention = new Map<string, number>();
  private pending: Promise<unknown> = Promise.resolve();
  private emit: (alert: Alert) => void = () => {};

  constructor(private opts: EngineOptions = {}) {}

  /** 저장된 규칙과 상태를 읽어 시작한다 */
  async init(): Promise<void> {
    const store = this.opts.store;
    if (!store) return;
    const [rules, states] = await Promise.all([store.loadRules(), store.loadStates()]);
    this.setRules(rules, states);
  }

  /**
   * 규칙 목록을 교체한다. 남아 있는 규칙의 상태는 유지하고, 사라진 규칙의 상태는 버린다.
   * states는 시작 시 저장된 상태를 넘길 때만 쓴다.
   */
  setRules(rules: Rule[], states: RuleState[] = []): void {
    const saved = new Map(states.map((s) => [s.ruleId, s]));
    const next = new Map<number, RuleState>();
    for (const r of rules) next.set(r.id, this.states.get(r.id) ?? saved.get(r.id) ?? { ruleId: r.id, armed: true });
    const pruned = [...this.states.keys()].some((id) => !next.has(id)) || states.some((s) => !next.has(s.ruleId));
    this.states = next;

    this.byKey.clear();
    this.priceRetention.clear();
    this.volumeRetention.clear();
    for (const r of rules) {
      if (!r.enabled) continue;
      const key = keyOf(r.market, r.symbol);
      (this.byKey.get(key) ?? this.byKey.set(key, []).get(key)!).push(r);
      const c = r.condition;
      if (c.type === 'change') this.priceRetention.set(key, Math.max(this.priceRetention.get(key) ?? 0, c.windowMs + MAX_STALE_MS));
      if (c.type === 'volume') this.volumeRetention.set(key, Math.max(this.volumeRetention.get(key) ?? 0, c.longMs + 2 * MINUTE));
    }
    for (const key of [...this.prices.keys()]) if (!this.priceRetention.has(key)) this.prices.delete(key);
    for (const key of [...this.volumes.keys()]) if (!this.volumeRetention.has(key)) this.volumes.delete(key);
    if (pruned) this.persist();
  }

  /** 버스에 연결한다. 발동한 알림은 rule.fired로 발행한다. 반환값은 연결 해제 함수. */
  attach(bus: EventBus): () => void {
    this.emit = (alert) => bus.emit({ type: 'rule.fired', ts: alert.firedAt, alert });
    const offs = [
      bus.on('market.ticker', (e) => void this.handle(e)),
      bus.on('market.kline', (e) => void this.handle(e)),
      bus.on('market.funding', (e) => void this.handle(e)),
      bus.on('rules.changed', () => this.reload()),
    ];
    return () => {
      for (const off of offs) off();
      this.emit = () => {};
    };
  }

  /** 저장소에서 규칙을 다시 읽는다 (rules.changed) */
  reload(): Promise<void> {
    const store = this.opts.store;
    if (!store) return Promise.resolve();
    const p = this.pending.then(async () => {
      try {
        this.setRules(await store.loadRules());
      } catch (e) {
        this.opts.logger?.error(LOG, `reload rules failed: ${String(e)}`);
      }
    });
    this.pending = p;
    return p;
  }

  /** 저장 대기 중인 작업을 모두 끝낸다 (종료 시 상태 저장, B9) */
  flush(): Promise<void> {
    return this.pending.then(() => undefined);
  }

  getStates(): RuleState[] {
    return [...this.states.values()];
  }

  handle(e: BlertEvent): Alert[] {
    switch (e.type) {
      case 'market.ticker':
        return this.onTicker(e);
      case 'market.kline':
        return this.onKline(e);
      case 'market.funding':
        return this.onFunding(e);
      default:
        return [];
    }
  }

  private onTicker(e: EventOf<'market.ticker'>): Alert[] {
    const ts = Date.parse(e.ts);
    const key = keyOf(e.market, e.symbol);
    const retention = this.priceRetention.get(key);
    if (retention !== undefined) this.history(key).add(ts, e.price);
    const alerts: Alert[] = [];
    for (const rule of this.active(key)) {
      const c = rule.condition;
      let m: Measurement | null = null;
      if (c.type === 'price') m = measurePrice(rule, e.price);
      else if (c.type === 'change') m = measureChange(rule, e.price, this.prices.get(key)?.priceAt(ts - c.windowMs));
      if (m) this.apply(rule, m, ts, alerts);
    }
    this.trim(key, ts);
    return alerts;
  }

  /** 1분봉: 거래량 판정과, 변동률용 가격 이력(백필 포함)을 채운다 */
  private onKline(e: EventOf<'market.kline'>): Alert[] {
    const ts = Date.parse(e.ts);
    const open = Date.parse(e.openTime);
    const key = keyOf(e.market, e.symbol);
    if (this.volumeRetention.has(key)) this.volumesOf(key).set(open, e.quoteVolume);
    if (e.closed && this.priceRetention.has(key)) this.history(key).add(open + MINUTE - 1, e.close);

    const alerts: Alert[] = [];
    const vols = this.volumes.get(key);
    if (vols) {
      for (const rule of this.active(key)) {
        const c = rule.condition;
        if (c.type !== 'volume') continue;
        const shortN = Math.ceil(c.shortMs / MINUTE);
        const longN = Math.ceil(c.longMs / MINUTE);
        if (!vols.covers(ts, longN)) continue; // 아직 긴 구간을 다 채우지 못함
        const m = measureVolume(rule, vols.sum(ts, shortN), vols.sum(ts, longN));
        if (m) this.apply(rule, m, ts, alerts);
      }
    }
    this.trim(key, ts);
    return alerts;
  }

  private onFunding(e: EventOf<'market.funding'>): Alert[] {
    const ts = Date.parse(e.ts);
    const alerts: Alert[] = [];
    for (const rule of this.active(keyOf('futures', e.symbol))) {
      const m = measureFunding(rule, e.rate * 100);
      if (m) this.apply(rule, m, ts, alerts);
    }
    return alerts;
  }

  /** 반복 정책을 적용해 발동 여부를 정한다 (B4 반복 정책 동작) */
  private apply(rule: Rule, m: Measurement, ts: number, out: Alert[]): void {
    const st = this.states.get(rule.id) ?? { ruleId: rule.id, armed: true };
    this.states.set(rule.id, st);
    const policy = rule.repeat;

    if (policy.kind === 'hysteresis' && !st.armed && rearmed(m, policy.widthPct)) {
      st.armed = true;
      this.persist();
    }
    if (!satisfied(m)) return;
    if (policy.kind === 'cooldown' && st.lastFiredAt && ts - Date.parse(st.lastFiredAt) < policy.ms) return;
    if (policy.kind === 'hysteresis' && !st.armed) return;

    st.lastFiredAt = iso(ts);
    if (policy.kind === 'hysteresis') st.armed = false;
    if (policy.kind === 'once') this.disable(rule);
    this.persist();

    const alert = toAlert(rule, m, st.lastFiredAt);
    out.push(alert);
    this.emit(alert);
  }

  /** 1회성: 삭제하지 않고 비활성으로 보관한다 */
  private disable(rule: Rule): void {
    rule.enabled = false;
    const list = this.byKey.get(keyOf(rule.market, rule.symbol));
    if (list) this.byKey.set(keyOf(rule.market, rule.symbol), list.filter((r) => r !== rule));
    const store = this.opts.store;
    if (!store) return;
    this.pending = this.pending.then(() =>
      store.setEnabled(rule.id, false).catch((e) => this.opts.logger?.error(LOG, `disable rule ${rule.id} failed: ${String(e)}`)),
    );
  }

  /** 상태(RuleState)를 저장한다. 저장은 순서대로 한 번에 하나씩 실행한다. */
  private persist(): void {
    const store = this.opts.store;
    if (!store) return;
    this.pending = this.pending.then(() =>
      store.saveStates(this.getStates()).catch((e) => this.opts.logger?.error(LOG, `save states failed: ${String(e)}`)),
    );
  }

  private active(key: string): Rule[] {
    return (this.byKey.get(key) ?? []).filter((r) => r.enabled);
  }

  private history(key: string): PriceHistory {
    return this.prices.get(key) ?? this.prices.set(key, new PriceHistory()).get(key)!;
  }

  private volumesOf(key: string): MinuteVolumes {
    return this.volumes.get(key) ?? this.volumes.set(key, new MinuteVolumes()).get(key)!;
  }

  private trim(key: string, ts: number): void {
    const pr = this.priceRetention.get(key);
    if (pr !== undefined) this.prices.get(key)?.trim(ts - pr);
    const vr = this.volumeRetention.get(key);
    if (vr !== undefined) this.volumes.get(key)?.trim(ts - vr);
  }
}
