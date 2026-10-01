import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine/index.js';
import { DEFAULT_REPEAT } from '../../src/shared/defaults.js';
import { planSubscriptions } from '../../src/binance/index.js';
import { render } from '../../src/notify/render.js';
import type { Alert, Rule } from '../../src/shared/types.js';
import { MIN, T0, fill, funding, position, rule } from './helpers.js';

const fire = (engine: Engine, ...events: Parameters<Engine['handle']>[0][]): Alert[] => events.flatMap((e) => engine.handle(e));
const liqRule = (pct: number, opts: { symbol?: string; id?: number } = {}): Rule =>
  rule({ type: 'liq', pct }, DEFAULT_REPEAT.liq, { market: 'futures', ...opts });
const futuresFill = (symbol = 'BTCUSDT', id?: number) => rule({ type: 'fill' }, DEFAULT_REPEAT.fill, { market: 'futures', symbol, id });

describe('engine 청산가 근접 알림 (FR-ALERT-05, D-46~D-49)', () => {
  it('AC-35 마크 가격이 청산가에서 5% 이내로 들어오면 warn 알림을 한 번 내고, 쿨다운 5분 안에는 다시 내지 않는다', () => {
    const engine = new Engine();
    engine.setRules([liqRule(5)]);
    // 롱 포지션: 청산가 80,000. 마크 90,000이면 거리 11.1%
    expect(fire(engine, position(T0, 'LONG', 0.5, 80_000, 90_000))).toHaveLength(0);
    // 마크 83,000 → 거리 3.6%: 5% 이내
    const alerts = fire(engine, funding(T0 + MIN, 0.01, 'BTCUSDT', 83_000));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'warn', titleKey: 'alert.liq.title' });
    expect(render(alerts[0]!)).toEqual({ title: 'BTC 선물 청산가까지 3.6%', body: '롱 청산가 80,000 · 마크 83,000 USDT · 기준 5% 이내' });
    // 쿨다운 안: 더 가까워져도 다시 알리지 않는다
    expect(fire(engine, funding(T0 + 2 * MIN, 0.01, 'BTCUSDT', 82_000), funding(T0 + 5 * MIN, 0.01, 'BTCUSDT', 81_000))).toHaveLength(0);
    // 쿨다운(5분)이 지나고 아직 기준 안이면 다시 알린다 (수준 기반, D-47)
    expect(fire(engine, funding(T0 + 6 * MIN + 1, 0.01, 'BTCUSDT', 81_000))).toHaveLength(1);
  });

  it('AC-36 시작할 때 이미 5% 이내이면 첫 포지션 조회 직후 바로 알린다', () => {
    const engine = new Engine();
    engine.setRules([liqRule(5)]);
    const alerts = fire(engine, position(T0, 'LONG', 1, 80_000, 82_000)); // 거리 2.4%
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.params).toMatchObject({ distance: '2.4%', side: 'LONG' });
  });

  it('AC-37 포지션이 없으면(크기 0 또는 청산가 0) 알리지 않는다', () => {
    const engine = new Engine();
    engine.setRules([liqRule(5)]);
    expect(fire(engine, position(T0, 'LONG', 0, 0, 83_000), position(T0, 'SHORT', 0, 0, 83_000), funding(T0 + MIN, 0.01, 'BTCUSDT', 83_000))).toHaveLength(0);
    // 교차 마진 등으로 청산가가 0이면 청산 위험이 없는 것으로 본다
    expect(fire(engine, position(T0 + 2 * MIN, 'LONG', 1, 0, 83_000))).toHaveLength(0);
  });

  it('AC-37 포지션을 아직 한 번도 받지 못했거나 마크 가격이 없으면 알리지 않는다', () => {
    const engine = new Engine();
    engine.setRules([liqRule(5)]);
    expect(fire(engine, funding(T0, 0.01, 'BTCUSDT', 83_000))).toHaveLength(0); // 포지션 정보 없음
    const other = new Engine();
    other.setRules([liqRule(5)]);
    expect(fire(other, position(T0, 'LONG', 1, 80_000, 0))).toHaveLength(0); // 마크 가격 없음
  });

  it('D-49 롱·숏이 함께 있으면 청산가에 더 가까운 쪽을 기준으로 판정한다', () => {
    const engine = new Engine();
    engine.setRules([liqRule(5)]);
    // 마크 100,000: 롱 청산가 90,000(거리 10%), 숏 청산가 103,000(거리 3%)
    const alerts = fire(engine, position(T0, 'LONG', 1, 90_000, 100_000), position(T0, 'SHORT', 1, 103_000, 100_000));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.params).toMatchObject({ side: 'SHORT', distance: '3.0%' });
    expect(render(alerts[0]!).body).toContain('숏 청산가');
  });

  it('D-49 한 방향이 정리되어 크기 0으로 갱신되면 그 방향은 더 이상 판정하지 않는다', () => {
    const engine = new Engine();
    engine.setRules([liqRule(5, { id: 1 })]);
    fire(engine, position(T0, 'LONG', 1, 80_000, 90_000), position(T0, 'SHORT', 1, 92_000, 90_000)); // 숏 2.2% → 알림
    expect(fire(engine, position(T0 + 10 * MIN, 'SHORT', 0, 0, 90_000))).toHaveLength(0); // 숏이 정리됨, 롱은 11%
  });

  it('다른 심볼의 포지션·마크 가격은 이 규칙에 영향을 주지 않는다', () => {
    const engine = new Engine();
    engine.setRules([liqRule(5, { symbol: 'ETHUSDT' })]);
    expect(fire(engine, position(T0, 'LONG', 1, 80_000, 81_000, 'BTCUSDT'), funding(T0, 0.01, 'BTCUSDT', 81_000))).toHaveLength(0);
    expect(fire(engine, position(T0, 'LONG', 1, 3_000, 3_050, 'ETHUSDT'))).toHaveLength(1);
  });

  it('일시정지한 규칙은 알리지 않고, 규칙 없이 들어온 포지션 이벤트는 무시한다', () => {
    const engine = new Engine();
    const paused = liqRule(5, { id: 3 });
    paused.enabled = false;
    engine.setRules([paused]);
    expect(fire(engine, position(T0, 'LONG', 1, 80_000, 81_000))).toHaveLength(0);
    expect(fire(new Engine(), position(T0, 'LONG', 1, 80_000, 81_000))).toHaveLength(0);
  });

  it('규칙의 --mode 지정(쿨다운 변경)이 반영된다', () => {
    const engine = new Engine();
    const r = liqRule(5);
    r.repeat = { kind: 'cooldown', ms: MIN };
    engine.setRules([r]);
    expect(fire(engine, position(T0, 'LONG', 1, 80_000, 82_000))).toHaveLength(1);
    expect(fire(engine, funding(T0 + MIN + 1, 0.01, 'BTCUSDT', 82_000))).toHaveLength(1);
  });

  it('청산가 규칙은 마크 가격 스트림만 구독하게 한다 (D-46)', () => {
    expect(planSubscriptions([liqRule(5)])).toEqual([{ market: 'futures', symbol: 'BTCUSDT', ticker: false, kline: false, funding: true, backfillMs: 0 }]);
  });
});

describe('engine 선물 체결 알림 (FR-ACC-03, D-52)', () => {
  it('AC-39 fill f:BTC는 선물 체결마다 account 알림을 내고 제목에 선물을 표시한다', () => {
    const engine = new Engine();
    engine.setRules([futuresFill('BTCUSDT', 7)]);
    const [a] = fire(engine, fill(T0, 'BTCUSDT', 'SELL', 0.01, 83_000, { market: 'futures' }));
    expect(a).toMatchObject({ ruleId: 7, kind: 'account', titleKey: 'alert.fill.futures.title' });
    expect(render(a!)).toEqual({ title: 'BTC 선물 매도 체결', body: '0.01 BTC @ 83,000 USDT' });
  });

  it('AC-39 같은 심볼 이름의 현물 체결은 선물 규칙을, 선물 체결은 현물 규칙을 울리지 않는다', () => {
    const engine = new Engine();
    const spotAll = rule({ type: 'fill' }, DEFAULT_REPEAT.fill, { symbol: '*', id: 1 });
    engine.setRules([futuresFill('BTCUSDT', 2), spotAll]);
    expect(fire(engine, fill(T0, 'BTCUSDT', 'BUY', 1, 70_000)).map((a) => a.ruleId)).toEqual([1]); // 현물 체결
    expect(fire(engine, fill(T0, 'BTCUSDT', 'BUY', 1, 70_000, { market: 'futures', tradeId: 2 })).map((a) => a.ruleId)).toEqual([2]); // 선물 체결
  });

  it('선물 체결 규칙은 공개 시세 스트림을 구독하게 하지 않는다', () => {
    expect(planSubscriptions([futuresFill('BTCUSDT')])).toEqual([]);
  });
});
