import type { Alert, Rule, RuleState } from '../shared/types.js';
import type { BlertEvent, EventOf } from '../shared/events.js';
import type { EventBus } from '../shared/bus.js';
import type { Logger } from '../shared/logger.js';
import { iso } from '../shared/clock.js';
import type { Store } from '../store/index.js';
import { MinuteVolumes, PriceHistory, MAX_STALE_MS, bucketFor } from './history.js';
import { measureBalance, measureChange, measureFill, measureFunding, measureLiq, measurePrice, measureVolume, rearmed, satisfied, toAlert, type Measurement } from './measure.js';

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
 * 가격·펀딩비는 '넘는 순간'(미충족 → 충족)에만 발동하고, 시작할 때 이미 충족 중이면 알리지 않는다.
 * 변동률·거래량은 현재 수준을 보고 반복 정책(쿨다운 등)으로 소음을 막는다.
 */
export class Engine {
  private byKey = new Map<string, Rule[]>();
  private states = new Map<number, RuleState>();
  private prices = new Map<string, PriceHistory>();
  private volumes = new Map<string, MinuteVolumes>();
  private priceRetention = new Map<string, number>();
  /** 심볼별 가격 표본 간격: 그 심볼에서 가장 짧은 변동률 창 기준 */
  private priceBucket = new Map<string, number>();
  private volumeRetention = new Map<string, number>();
  /** 교차 판정용: 규칙별 직전 충족 여부. 처음 관측하면 기준만 기록하고 발동하지 않는다. */
  private wasSatisfied = new Map<number, boolean>();
  /** 계정 알림(체결·잔고) 규칙. 심볼 구독과 무관하게 계정 이벤트마다 확인한다 */
  private accountRules: Rule[] = [];
  /** 잔고 알림의 기준: 규칙별·자산별 마지막 알림 시점(또는 처음 본) 잔고 */
  private balanceBase = new Map<number, Map<string, number>>();
  /** 선물 포지션(청산가 판정용): 심볼 → 방향 → 크기·청산가. account.position이 갱신한다 */
  private positions = new Map<string, Map<'LONG' | 'SHORT', { size: number; liqPrice: number }>>();
  /** 심볼별 마지막 마크 가격 (마크 가격 스트림 또는 포지션 조회) */
  private marks = new Map<string, number>();
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
    for (const r of rules) if (!r.enabled) this.wasSatisfied.delete(r.id); // 다시 켜지면 새로 기준을 잡는다
    for (const id of [...this.wasSatisfied.keys()]) if (!next.has(id)) this.wasSatisfied.delete(id);
    for (const r of rules) if (!r.enabled) this.balanceBase.delete(r.id);
    for (const id of [...this.balanceBase.keys()]) if (!next.has(id)) this.balanceBase.delete(id);
    this.accountRules = rules.filter((r) => r.enabled && (r.condition.type === 'fill' || r.condition.type === 'balance'));

    this.byKey.clear();
    this.priceRetention.clear();
    this.priceBucket.clear();
    this.volumeRetention.clear();
    for (const r of rules) {
      if (!r.enabled || r.condition.type === 'fill' || r.condition.type === 'balance') continue;
      const key = keyOf(r.market, r.symbol);
      (this.byKey.get(key) ?? this.byKey.set(key, []).get(key)!).push(r);
      const c = r.condition;
      if (c.type === 'change') {
        this.priceRetention.set(key, Math.max(this.priceRetention.get(key) ?? 0, c.windowMs + MAX_STALE_MS));
        this.priceBucket.set(key, Math.min(this.priceBucket.get(key) ?? Infinity, bucketFor(c.windowMs)));
      }
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
      bus.on('account.fill', (e) => void this.handle(e)),
      bus.on('account.balance', (e) => void this.handle(e)),
      bus.on('account.position', (e) => void this.handle(e)),
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
      case 'account.fill':
        return this.onFill(e);
      case 'account.balance':
        return this.onBalance(e);
      case 'account.position':
        return this.onPosition(e);
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

    // 백필한 과거 봉은 이력만 채운다. 지금 진행 중인 분의 봉만 판정해서 과거 급증을 새 알림으로 내지 않는다.
    if (Math.floor(ts / MINUTE) * MINUTE !== Math.floor(open / MINUTE) * MINUTE) {
      this.trim(key, ts);
      return [];
    }
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
    // 마크 가격 스트림은 청산가 거리를 계속 다시 계산하는 데 쓴다 (D-46)
    if (e.markPrice !== undefined && e.markPrice > 0) {
      this.marks.set(e.symbol, e.markPrice);
      this.checkLiq(e.symbol, ts, alerts);
    }
    return alerts;
  }

  /** 선물 포지션 갱신: 방향별 크기·청산가를 기억하고 청산가 근접 규칙을 다시 판정한다 */
  private onPosition(e: EventOf<'account.position'>): Alert[] {
    const ts = Date.parse(e.ts);
    const sides = this.positions.get(e.symbol) ?? this.positions.set(e.symbol, new Map()).get(e.symbol)!;
    sides.set(e.side, { size: e.size, liqPrice: e.liqPrice });
    if (e.markPrice > 0) this.marks.set(e.symbol, e.markPrice);
    const alerts: Alert[] = [];
    this.checkLiq(e.symbol, ts, alerts);
    return alerts;
  }

  private checkLiq(symbol: string, ts: number, out: Alert[]): void {
    const rules = this.active(keyOf('futures', symbol)).filter((r) => r.condition.type === 'liq');
    if (rules.length === 0) return;
    const sides = this.positions.get(symbol);
    if (!sides) return; // 포지션을 아직 한 번도 받지 못했다
    const views = [...sides].map(([side, p]) => ({ side, size: p.size, liqPrice: p.liqPrice }));
    for (const rule of rules) {
      const m = measureLiq(rule, views, this.marks.get(symbol));
      if (m) this.apply(rule, m, ts, out);
    }
  }

  /** 주문 체결: 이벤트마다 알린다. 규칙은 심볼 하나 또는 전체('*')다. */
  private onFill(e: EventOf<'account.fill'>): Alert[] {
    const ts = Date.parse(e.ts);
    const alerts: Alert[] = [];
    for (const rule of this.accountRules) {
      if (rule.condition.type !== 'fill' || !rule.enabled) continue;
      if (rule.market !== e.market) continue; // 현물과 선물은 심볼 이름이 같아도 다른 체결이다
      if (rule.symbol !== '*' && rule.symbol !== e.symbol) continue;
      const m = measureFill(rule, e);
      if (m) this.apply(rule, m, ts, alerts);
    }
    return alerts;
  }

  /** 잔고 변동: 마지막 알림 시점 대비 일정 % 이상 바뀌면 알린다. 쿨다운 중에는 기준을 옮기지 않는다. */
  private onBalance(e: EventOf<'account.balance'>): Alert[] {
    const ts = Date.parse(e.ts);
    const total = e.free + e.locked;
    const alerts: Alert[] = [];
    for (const rule of this.accountRules) {
      const c = rule.condition;
      if (c.type !== 'balance' || !rule.enabled || (c.asset !== '*' && c.asset !== e.asset)) continue;
      const bases = this.balanceBase.get(rule.id) ?? this.balanceBase.set(rule.id, new Map()).get(rule.id)!;
      const base = bases.get(e.asset);
      if (base === undefined || base === 0) {
        bases.set(e.asset, total); // 처음 본 값(또는 0에서 시작)은 기준만 잡는다
        continue;
      }
      const m = measureBalance(rule, e.asset, base, total, () => bases.set(e.asset, total));
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
    const sat = satisfied(m);
    if (m.edge) {
      const prev = this.wasSatisfied.get(rule.id);
      this.wasSatisfied.set(rule.id, sat);
      if (prev !== false) return; // 첫 관측(기준 기록)이거나 이미 충족 중이면 '넘는 순간'이 아니다
    }
    if (!sat) return;
    if (policy.kind === 'cooldown' && st.lastFiredAt && ts - Date.parse(st.lastFiredAt) < policy.ms) return;
    if (policy.kind === 'hysteresis' && !st.armed) return;

    st.lastFiredAt = iso(ts);
    if (policy.kind === 'hysteresis') st.armed = false;
    if (policy.kind === 'once') this.disable(rule);
    this.persist();

    m.onFire?.();
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
    const bucket = this.priceBucket.get(key) ?? 1000;
    const current = this.prices.get(key);
    // 더 짧은 창의 규칙이 생겨 지금 간격이 너무 성기면 새로 시작한다 (모자란 이력은 백필·수집으로 다시 쌓인다)
    if (current && current.bucketMs <= bucket) return current;
    const fresh = new PriceHistory(bucket);
    this.prices.set(key, fresh);
    return fresh;
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
