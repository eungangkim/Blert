import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../src/engine/index.js';
import { PriceHistory } from '../../src/engine/history.js';
import { Store } from '../../src/store/index.js';
import { EventBus } from '../../src/shared/bus.js';
import { DEFAULT_REPEAT } from '../../src/shared/defaults.js';
import { hasMessage } from '../../src/i18n/index.js';
import type { Alert } from '../../src/shared/types.js';
import { HOUR, MIN, T0, funding, kline, rule, ticker } from './helpers.js';

const fire = (engine: Engine, ...events: Parameters<Engine['handle']>[0][]): Alert[] => events.flatMap((e) => engine.handle(e));

describe('engine 가격 (FR-ALERT-01)', () => {
  it('AC-09 above 70000: 69,990 → 70,010에서 1회 발동, 71,000에는 재발동 없음', () => {
    const engine = new Engine();
    const r = rule({ type: 'price', direction: 'above', price: 70000 }, { kind: 'once' });
    engine.setRules([r]);
    expect(fire(engine, ticker(T0, 69_990))).toHaveLength(0);
    const alerts = fire(engine, ticker(T0 + 1000, 70_010), ticker(T0 + 2000, 71_000));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ ruleId: r.id, kind: 'up', titleKey: 'alert.price.above.title' });
    expect(alerts[0]!.params).toMatchObject({ coin: 'BTC', quote: 'USDT', market: 'spot', target: '70,000', price: '70,010' });
    expect(r.enabled).toBe(false);
  });

  it('below는 이탈 시 down 종류로 발동하고, 다른 시장·심볼 이벤트는 무시한다', () => {
    const engine = new Engine();
    engine.setRules([rule({ type: 'price', direction: 'below', price: 65000 }, { kind: 'once' })]);
    expect(fire(engine, ticker(T0, 60_000, 'futures'), ticker(T0, 60_000, 'spot', 'ETHUSDT'))).toHaveLength(0);
    const [a] = fire(engine, ticker(T0, 64_980));
    expect(a).toMatchObject({ kind: 'down', titleKey: 'alert.price.below.title' });
  });

  it('일시정지(비활성) 규칙은 평가하지 않는다', () => {
    const engine = new Engine();
    const r = rule({ type: 'price', direction: 'above', price: 1 }, { kind: 'once' });
    r.enabled = false;
    engine.setRules([r]);
    expect(fire(engine, ticker(T0, 5))).toHaveLength(0);
  });
});

describe('engine 변동률 (FR-ALERT-02)', () => {
  const change = (direction: 'up' | 'down' | 'both' = 'both') =>
    rule({ type: 'change', pct: 5, windowMs: HOUR, direction }, DEFAULT_REPEAT.change);

  it('AC-10 1시간 전 대비 +5.1%면 발동하고 기준 가격과 변동률이 알림에 담긴다', () => {
    const engine = new Engine();
    engine.setRules([change()]);
    fire(engine, ticker(T0, 1000));
    expect(fire(engine, ticker(T0 + HOUR, 1049))).toHaveLength(0);
    const [a] = fire(engine, ticker(T0 + HOUR + 1000, 1051));
    expect(a).toMatchObject({ kind: 'up', titleKey: 'alert.change.title' });
    expect(a!.params).toMatchObject({ window: '1h', pct: '+5.1%', from: '1,000', to: '1,051' });
  });

  it('down 방향은 하락에만, 양방향은 하락도 잡고 kind가 down이 된다', () => {
    const up = new Engine();
    up.setRules([change('up')]);
    fire(up, ticker(T0, 1000));
    expect(fire(up, ticker(T0 + HOUR, 940))).toHaveLength(0);

    const both = new Engine();
    both.setRules([change('both')]);
    fire(both, ticker(T0, 1000));
    const [a] = fire(both, ticker(T0 + HOUR, 940));
    expect(a).toMatchObject({ kind: 'down' });
    expect(a!.params.pct).toBe('−6.0%');

    const down = new Engine();
    down.setRules([change('down')]);
    fire(down, ticker(T0, 1000));
    expect(fire(down, ticker(T0 + HOUR, 1100))).toHaveLength(0);
    expect(fire(down, ticker(T0 + HOUR + 1000, 940))).toHaveLength(1);
  });

  it('이력이 기간을 채우기 전에는 큰 변동이 있어도 발동하지 않는다', () => {
    const engine = new Engine();
    engine.setRules([change()]);
    fire(engine, ticker(T0, 1000));
    expect(fire(engine, ticker(T0 + 30 * MIN, 2000))).toHaveLength(0);
  });

  it('감시 공백으로 기준 표본이 너무 오래됐으면 잘못된 비교를 하지 않는다', () => {
    const engine = new Engine();
    engine.setRules([change()]);
    fire(engine, ticker(T0, 1000), ticker(T0 + 5 * MIN, 1000));
    // 2시간 공백 뒤: (now - 1h) 시점 이전 마지막 표본이 55분 넘게 오래됨
    expect(fire(engine, ticker(T0 + 2 * HOUR, 2000))).toHaveLength(0);
  });

  it('D-33 백필한 1분봉으로 시작 직후부터 변동률을 판정한다', () => {
    const engine = new Engine();
    engine.setRules([change('up')]);
    // 기간(1시간) + 여유 2분만큼 종가 1000인 1분봉을 백필 (D-33, B5)
    const events = Array.from({ length: 62 }, (_, i) => kline(T0 + (i - 2) * MIN, 1, { close: 1000 }));
    fire(engine, ...events);
    const [a] = fire(engine, ticker(T0 + HOUR + 1000, 1060));
    expect(a).toBeDefined();
    expect(a!.params).toMatchObject({ from: '1,000', to: '1,060', pct: '+6.0%' });
  });

  it('가격 이력은 필요한 기간만 유지한다', () => {
    const h = new PriceHistory();
    for (let i = 0; i < 10_000; i++) h.add(T0 + i * 1000, i);
    h.trim(T0 + 9_000 * 1000);
    expect(h.size).toBeLessThan(1_100);
    expect(h.priceAt(T0 + 9_000 * 1000)).toBe(9_000);
  });
});

describe('engine 거래량 (FR-ALERT-03)', () => {
  const volume = () => rule({ type: 'volume', multiple: 3, shortMs: 5 * MIN, longMs: HOUR }, DEFAULT_REPEAT.volume);

  /** 0~54분은 1,000, 55~59분은 recent */
  const minutes = (recent: number) =>
    Array.from({ length: 60 }, (_, i) => kline(T0 + i * MIN, i >= 55 ? recent : 1000, { now: T0 + 59 * MIN + 30_000 }));

  it('AC-11 5분 거래대금이 1시간 평균의 3.2배면 발동한다', () => {
    const engine = new Engine();
    engine.setRules([volume()]);
    const alerts = fire(engine, ...minutes(4000));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'up', titleKey: 'alert.volume.title' });
    expect(alerts[0]!.params).toMatchObject({ ratio: '3.2', short: '5m', long: '1h', shortVol: '20.0K', avgVol: '6.3K' });
  });

  it('배수에 못 미치면 발동하지 않는다', () => {
    const engine = new Engine();
    engine.setRules([volume()]);
    expect(fire(engine, ...minutes(2000))).toHaveLength(0);
  });

  it('긴 구간 데이터가 모자라면(백필 실패 등) 오탐하지 않는다', () => {
    const engine = new Engine();
    engine.setRules([volume()]);
    const partial = Array.from({ length: 10 }, (_, i) => kline(T0 + (50 + i) * MIN, i >= 5 ? 4000 : 10, { now: T0 + 59 * MIN + 30_000 }));
    expect(fire(engine, ...partial)).toHaveLength(0);
  });

  it('진행 중인 봉(closed=false)의 갱신도 거래량 판정에 반영된다', () => {
    const engine = new Engine();
    engine.setRules([volume()]);
    const base = Array.from({ length: 59 }, (_, i) => kline(T0 + i * MIN, 1000, { now: T0 + 59 * MIN }));
    fire(engine, ...base);
    expect(fire(engine, kline(T0 + 59 * MIN, 500, { closed: false, now: T0 + 59 * MIN + 10_000 }))).toHaveLength(0);
    expect(fire(engine, kline(T0 + 59 * MIN, 30_000, { closed: false, now: T0 + 59 * MIN + 20_000 }))).toHaveLength(1);
  });
});

describe('engine 펀딩비 (FR-ALERT-04)', () => {
  it('AC-12 above 0.05% 규칙에 0.06%가 들어오면 warn으로 발동한다', () => {
    const engine = new Engine();
    engine.setRules([rule({ type: 'funding', direction: 'above', pct: 0.05 }, DEFAULT_REPEAT.funding)]);
    expect(fire(engine, funding(T0, 0.04))).toHaveLength(0);
    const [a] = fire(engine, funding(T0 + 1000, 0.06));
    expect(a).toMatchObject({ kind: 'warn', titleKey: 'alert.funding.above.title' });
    expect(a!.params).toMatchObject({ rate: '0.060%', threshold: '0.050%', coin: 'BTC' });
  });

  it('기준과 같은 값은 초과가 아니므로 발동하지 않는다', () => {
    const engine = new Engine();
    engine.setRules([rule({ type: 'funding', direction: 'above', pct: 0.05 }, DEFAULT_REPEAT.funding)]);
    expect(fire(engine, funding(T0, 0.05))).toHaveLength(0);
  });

  it('below -0.05% 규칙은 음수 펀딩비에서 발동한다', () => {
    const engine = new Engine();
    engine.setRules([rule({ type: 'funding', direction: 'below', pct: -0.05 }, DEFAULT_REPEAT.funding)]);
    expect(fire(engine, funding(T0, -0.03))).toHaveLength(0);
    expect(fire(engine, funding(T0 + 1000, -0.07))).toHaveLength(1);
  });
});

describe('engine 반복 정책 (FR-REP-01)', () => {
  it('AC-13 쿨다운 30분: 10분 뒤에는 발동하지 않고 31분 뒤에는 발동한다', () => {
    const engine = new Engine();
    engine.setRules([rule({ type: 'price', direction: 'above', price: 100 }, { kind: 'cooldown', ms: 30 * MIN })]);
    expect(fire(engine, ticker(T0, 101))).toHaveLength(1);
    expect(fire(engine, ticker(T0 + 10 * MIN, 101))).toHaveLength(0);
    expect(fire(engine, ticker(T0 + 31 * MIN, 101))).toHaveLength(1);
  });

  it('AC-14 히스테리시스 20%: 0.04% 아래로 내려간 뒤에만 재발동한다', () => {
    const engine = new Engine();
    engine.setRules([rule({ type: 'funding', direction: 'above', pct: 0.05 }, { kind: 'hysteresis', widthPct: 20 })]);
    let t = T0;
    const step = (rate: number) => fire(engine, funding((t += 1000), rate)).length;
    expect(step(0.06)).toBe(1); // 첫 발동, armed=false
    expect(step(0.045)).toBe(0); // 기준 아래지만 0.04까지는 안 내려감
    expect(step(0.06)).toBe(0); // 아직 재무장 안 됨
    expect(step(0.035)).toBe(0); // 재무장
    expect(engine.getStates()[0]).toMatchObject({ armed: true });
    expect(step(0.06)).toBe(1);
  });

  it('히스테리시스 below(음수 기준)는 반대(위)로 폭만큼 벗어나야 재무장한다', () => {
    const engine = new Engine();
    engine.setRules([rule({ type: 'funding', direction: 'below', pct: -0.05 }, { kind: 'hysteresis', widthPct: 20 })]);
    let t = T0;
    const step = (rate: number) => fire(engine, funding((t += 1000), rate)).length;
    expect(step(-0.06)).toBe(1);
    expect(step(-0.045)).toBe(0); // -0.04 이상이어야 재무장
    expect(step(-0.06)).toBe(0);
    expect(step(-0.03)).toBe(0); // 재무장
    expect(step(-0.06)).toBe(1);
  });

  it('가격 히스테리시스 0.5%: 기준 아래로 0.5% 이상 내려간 뒤 재발동한다', () => {
    const engine = new Engine();
    engine.setRules([rule({ type: 'price', direction: 'above', price: 70000 }, { kind: 'hysteresis', widthPct: 0.5 })]);
    let t = T0;
    const step = (p: number) => fire(engine, ticker((t += 1000), p)).length;
    expect(step(70_100)).toBe(1);
    expect(step(69_800)).toBe(0); // 69,650까지는 안 내려감
    expect(step(70_100)).toBe(0);
    expect(step(69_600)).toBe(0); // 재무장
    expect(step(70_100)).toBe(1);
  });

  it('발동한 알림은 모두 ko.json에 제목·본문 키가 있다', () => {
    const engine = new Engine();
    engine.setRules([
      rule({ type: 'price', direction: 'above', price: 1 }, { kind: 'once' }, { id: 101 }),
      rule({ type: 'price', direction: 'below', price: 10 }, { kind: 'once' }, { id: 102, symbol: 'ETHUSDT' }),
      rule({ type: 'funding', direction: 'above', pct: 0.01 }, { kind: 'once' }, { id: 103 }),
      rule({ type: 'funding', direction: 'below', pct: 0.5 }, { kind: 'once' }, { id: 104, symbol: 'SOLUSDT' }),
    ]);
    const alerts = fire(engine, ticker(T0, 5), ticker(T0, 5, 'spot', 'ETHUSDT'), funding(T0, 0.05), funding(T0, 0.05, 'SOLUSDT'));
    expect(alerts).toHaveLength(4);
    for (const a of alerts) {
      expect(hasMessage(a.titleKey), a.titleKey).toBe(true);
      expect(hasMessage(a.titleKey.replace(/\.title$/, '.body')), a.titleKey).toBe(true);
    }
  });
});

describe('engine 저장소·이벤트 버스 연동', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blert-engine-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const draft = (price: number, repeat = DEFAULT_REPEAT.price) => ({
    type: 'price' as const, market: 'spot' as const, symbol: 'BTCUSDT',
    condition: { type: 'price' as const, direction: 'above' as const, price }, repeat,
    source: 'manual' as const, enabled: true,
  });

  it('AC-09 1회성 규칙이 발동하면 삭제하지 않고 비활성으로 저장한다', async () => {
    const store = new Store(dir);
    await store.addRules([draft(70000)]);
    const engine = new Engine({ store });
    await engine.init();
    engine.handle(ticker(T0, 70_010));
    await engine.flush();
    const [saved] = await store.loadRules();
    expect(saved).toMatchObject({ id: 1, enabled: false });
    expect(await store.loadStates()).toMatchObject([{ ruleId: 1, lastFiredAt: '2026-10-03T00:00:00.000Z' }]);
  });

  it('재시작해도 쿨다운 상태를 이어받는다', async () => {
    const store = new Store(dir);
    await store.addRules([draft(100, { kind: 'cooldown', ms: 30 * MIN })]);
    const first = new Engine({ store });
    await first.init();
    expect(first.handle(ticker(T0, 101))).toHaveLength(1);
    await first.flush();

    const second = new Engine({ store });
    await second.init();
    expect(second.handle(ticker(T0 + 10 * MIN, 101))).toHaveLength(0);
    expect(second.handle(ticker(T0 + 31 * MIN, 101))).toHaveLength(1);
    await second.flush();
  });

  it('버스로 받은 시장 이벤트를 rule.fired로 내보내고, rules.changed에 규칙을 다시 읽는다', async () => {
    const store = new Store(dir);
    const bus = new EventBus();
    const engine = new Engine({ store });
    await engine.init();
    const off = engine.attach(bus);
    const fired: Alert[] = [];
    bus.on('rule.fired', (e) => fired.push(e.alert));

    bus.emit(ticker(T0, 100));
    expect(fired).toHaveLength(0); // 규칙이 아직 없음

    await store.addRules([draft(50)]);
    bus.emit({ type: 'rules.changed', ts: '', ruleIds: [1] });
    await engine.flush();
    bus.emit(ticker(T0 + 1000, 100));
    expect(fired).toHaveLength(1);
    expect(fired[0]!.ruleId).toBe(1);

    off();
    await store.addRules([draft(50)]);
    bus.emit(ticker(T0 + 2000, 100));
    expect(fired).toHaveLength(1);
  });

  it('삭제된 규칙의 상태는 저장 시 정리된다', async () => {
    const store = new Store(dir);
    await store.addRules([draft(100, { kind: 'cooldown', ms: MIN }), draft(100, { kind: 'cooldown', ms: MIN })]);
    const engine = new Engine({ store });
    await engine.init();
    engine.handle(ticker(T0, 101));
    await engine.flush();
    expect((await store.loadStates()).map((s) => s.ruleId)).toEqual([1, 2]);
    await store.deleteRules(1);
    await engine.reload();
    await engine.flush();
    expect((await store.loadStates()).map((s) => s.ruleId)).toEqual([2]);
  });
});
