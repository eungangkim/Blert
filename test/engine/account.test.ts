import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../src/engine/index.js';
import { Store } from '../../src/store/index.js';
import { DEFAULT_REPEAT } from '../../src/shared/defaults.js';
import { planSubscriptions } from '../../src/binance/index.js';
import { render } from '../../src/notify/render.js';
import type { Alert, Condition, Rule } from '../../src/shared/types.js';
import { MIN, T0, balance, fill, rule, ticker } from './helpers.js';

const fire = (engine: Engine, ...events: Parameters<Engine['handle']>[0][]): Alert[] => events.flatMap((e) => engine.handle(e));
const fillRule = (symbol = '*', id?: number) => rule({ type: 'fill' }, DEFAULT_REPEAT.fill, { symbol, id });
const balanceRule = (asset: string, pct: number, id?: number) =>
  rule({ type: 'balance', asset, pct }, DEFAULT_REPEAT.balance, { symbol: '*', id });

describe('engine 체결 알림 (FR-ACC-01)', () => {
  it('AC-31 fill all은 체결 이벤트마다 account 알림을 한 번씩 낸다', () => {
    const engine = new Engine();
    engine.setRules([fillRule('*')]);
    const alerts = fire(engine, fill(T0, 'BTCUSDT', 'BUY', 0.015, 68_420), fill(T0 + 1000, 'ETHUSDT', 'SELL', 2, 3_412.5, { tradeId: 2 }));
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ kind: 'account', titleKey: 'alert.fill.title' });
    expect(render(alerts[0]!)).toEqual({ title: 'BTC 매수 체결', body: '0.015 BTC @ 68,420 USDT' }); // B7 예시
    expect(render(alerts[1]!)).toEqual({ title: 'ETH 매도 체결', body: '2 ETH @ 3,412.5 USDT' });
  });

  it('AC-31 같은 순간에 여러 건이 체결돼도 반복 정책 없이 모두 알린다 (쿨다운 없음)', () => {
    const engine = new Engine();
    engine.setRules([fillRule('*')]);
    const alerts = fire(engine, ...[1, 2, 3, 4].map((i) => fill(T0 + i, 'BTCUSDT', 'BUY', 0.1, 68_000, { tradeId: i })));
    expect(alerts).toHaveLength(4);
  });

  it('특정 심볼 규칙은 그 심볼의 체결만 알리고, 일시정지한 규칙은 알리지 않는다', () => {
    const engine = new Engine();
    const paused = fillRule('SOLUSDT', 11);
    paused.enabled = false;
    engine.setRules([fillRule('BTCUSDT', 10), paused]);
    expect(fire(engine, fill(T0, 'ETHUSDT', 'BUY', 1, 3000), fill(T0, 'SOLUSDT', 'BUY', 1, 150))).toHaveLength(0);
    const [a] = fire(engine, fill(T0, 'BTCUSDT', 'SELL', 0.5, 67_000));
    expect(a).toMatchObject({ ruleId: 10 });
  });

  it('전체 규칙과 심볼 규칙이 함께 있으면 각각 알린다', () => {
    const engine = new Engine();
    engine.setRules([fillRule('*', 1), fillRule('BTCUSDT', 2)]);
    expect(fire(engine, fill(T0, 'BTCUSDT', 'BUY', 1, 70_000)).map((a) => a.ruleId)).toEqual([1, 2]);
  });

  it('규칙의 --sound 지정이 알림에 담긴다', () => {
    const engine = new Engine();
    const r = fillRule('*');
    r.sound = 'off';
    engine.setRules([r]);
    expect(fire(engine, fill(T0, 'BTCUSDT', 'BUY', 1, 70_000))[0]!.sound).toBe('off');
  });

  it('견적 통화를 알 수 없는 쌍(ETHBTC)은 심볼 그대로 보여준다', () => {
    const engine = new Engine();
    engine.setRules([fillRule('*')]);
    const [a] = fire(engine, fill(T0, 'ETHBTC', 'BUY', 0.5, 0.052));
    expect(render(a!)).toEqual({ title: 'ETHBTC 매수 체결', body: '0.5 ETHBTC @ 0.052' });
  });

  it('체결 알림은 반복 정책 상태를 저장 파일에 쌓지 않아도 매번 발동한다', () => {
    const engine = new Engine();
    engine.setRules([fillRule('*')]);
    fire(engine, fill(T0, 'BTCUSDT', 'BUY', 1, 70_000));
    expect(fire(engine, fill(T0 + 1, 'BTCUSDT', 'BUY', 1, 70_000, { tradeId: 2 }))).toHaveLength(1);
  });
});

describe('engine 잔고 알림 (FR-ACC-02, D-27)', () => {
  it('AC-32 USDT 5%: 6% 감소는 알리고, 5분 뒤 또 6% 감소는 쿨다운(10분) 때문에 알리지 않는다', () => {
    const engine = new Engine();
    engine.setRules([balanceRule('USDT', 5)]);
    expect(fire(engine, balance(T0, 'USDT', 1000))).toHaveLength(0); // 시작 시 잔고가 기준
    const first = fire(engine, balance(T0 + 1 * MIN, 'USDT', 940));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'account', titleKey: 'alert.balance.title' });
    expect(render(first[0]!)).toEqual({ title: 'USDT 잔고 \u22126.0%', body: '1,000 → 940 USDT' });

    expect(fire(engine, balance(T0 + 6 * MIN, 'USDT', 884))).toHaveLength(0); // 940 대비 −5.96%지만 쿨다운 중
  });

  it('AC-32 쿨다운이 끝난 뒤에는 쿨다운 중 옮기지 않은 기준(마지막 알림 시점)과 비교해 알린다', () => {
    const engine = new Engine();
    engine.setRules([balanceRule('USDT', 5)]);
    fire(engine, balance(T0, 'USDT', 1000), balance(T0 + 1 * MIN, 'USDT', 940));
    fire(engine, balance(T0 + 6 * MIN, 'USDT', 884)); // 쿨다운 중: 기준은 940 그대로
    const [a] = fire(engine, balance(T0 + 12 * MIN, 'USDT', 884));
    expect(render(a!)).toEqual({ title: 'USDT 잔고 \u22126.0%', body: '940 → 884 USDT' });
  });

  it('작은 변동은 기준을 옮기지 않아 누적해서 기준을 넘으면 알린다', () => {
    const engine = new Engine();
    engine.setRules([balanceRule('USDT', 5)]);
    fire(engine, balance(T0, 'USDT', 1000));
    expect(fire(engine, balance(T0 + MIN, 'USDT', 970))).toHaveLength(0); // −3%
    expect(fire(engine, balance(T0 + 2 * MIN, 'USDT', 940))).toHaveLength(1); // 처음 기준 대비 −6%
  });

  it('증가도 알리고(+), free와 locked의 합계로 계산한다', () => {
    const engine = new Engine();
    engine.setRules([balanceRule('BTC', 10)]);
    fire(engine, balance(T0, 'BTC', 1, 0.5)); // 합계 1.5
    const [a] = fire(engine, balance(T0 + MIN, 'BTC', 1, 0.8)); // 합계 1.8 = +20%
    expect(render(a!)).toEqual({ title: 'BTC 잔고 +20.0%', body: '1.5 → 1.8 BTC' });
    expect(fire(engine, balance(T0 + 2 * MIN, 'BTC', 0.3, 1.5))).toHaveLength(0); // free↔locked 이동은 합계가 같다(1.8)
  });

  it('all은 자산별로 따로 기준을 잡고, 다른 자산의 변동은 서로 영향을 주지 않는다', () => {
    const engine = new Engine();
    engine.setRules([balanceRule('*', 5)]);
    fire(engine, balance(T0, 'USDT', 1000), balance(T0, 'BTC', 2));
    const alerts = fire(engine, balance(T0 + MIN, 'BTC', 1.8));
    expect(alerts).toHaveLength(1);
    expect(render(alerts[0]!).title).toBe('BTC 잔고 \u221210.0%');
    expect(fire(engine, balance(T0 + 2 * MIN, 'USDT', 990))).toHaveLength(0); // USDT는 −1%
  });

  it('기준이 없거나 0이면 알리지 않고 기준만 잡는다', () => {
    const engine = new Engine();
    engine.setRules([balanceRule('USDT', 5)]);
    expect(fire(engine, balance(T0, 'USDT', 0))).toHaveLength(0); // 0에서 시작
    expect(fire(engine, balance(T0 + MIN, 'USDT', 500))).toHaveLength(0); // 0 → 500은 변동률을 낼 수 없음: 기준만 갱신
    expect(fire(engine, balance(T0 + 2 * MIN, 'USDT', 400))).toHaveLength(1); // 500 대비 −20%
  });

  it('다른 자산의 이벤트는 무시한다', () => {
    const engine = new Engine();
    engine.setRules([balanceRule('USDT', 5)]);
    fire(engine, balance(T0, 'USDT', 1000));
    expect(fire(engine, balance(T0 + MIN, 'BTC', 1), balance(T0 + 2 * MIN, 'BTC', 0.1))).toHaveLength(0);
  });

  it('규칙을 일시정지했다 재개하면 기준을 새로 잡는다', () => {
    const engine = new Engine();
    const r = balanceRule('USDT', 5);
    engine.setRules([r]);
    fire(engine, balance(T0, 'USDT', 1000));
    engine.setRules([{ ...r, enabled: false }]);
    engine.setRules([r]);
    expect(fire(engine, balance(T0 + 20 * MIN, 'USDT', 500))).toHaveLength(0); // 재개 후 첫 값이 기준
    expect(fire(engine, balance(T0 + 21 * MIN, 'USDT', 400))).toHaveLength(1);
  });

  it('쿨다운 상태는 저장되어 재시작해도 이어받고, 기준은 새로 잡는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blert-balance-'));
    try {
      const store = new Store(dir);
      await store.addRules([{ type: 'balance', market: 'spot', symbol: '*', condition: { type: 'balance', asset: 'USDT', pct: 5 } as Condition, repeat: DEFAULT_REPEAT.balance, source: 'manual', enabled: true }]);
      const first = new Engine({ store });
      await first.init();
      first.handle(balance(T0, 'USDT', 1000));
      expect(first.handle(balance(T0 + MIN, 'USDT', 900))).toHaveLength(1);
      await first.flush();

      const second = new Engine({ store });
      await second.init();
      second.handle(balance(T0 + 2 * MIN, 'USDT', 900)); // 새 기준
      expect(second.handle(balance(T0 + 3 * MIN, 'USDT', 800))).toHaveLength(0); // 아직 쿨다운 중 (마지막 알림 T0+1m)
      expect(second.handle(balance(T0 + 12 * MIN, 'USDT', 700))).toHaveLength(1);
      await second.flush();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('engine 계정 알림과 공개 알림의 공존', () => {
  it('계정 규칙이 있어도 공개 가격 규칙은 그대로 동작하고, 계정 규칙은 심볼 구독을 만들지 않는다', () => {
    const engine = new Engine();
    const price = rule({ type: 'price', direction: 'above', price: 100 }, { kind: 'once' }, { id: 50 });
    engine.setRules([fillRule('*', 51), balanceRule('USDT', 5, 52), price]);
    expect(engine.handle(ticker(T0, 99))).toHaveLength(0);
    expect(engine.handle(ticker(T0 + 1000, 101))).toHaveLength(1);

    const plan = planSubscriptions([fillRule('*', 1), balanceRule('USDT', 5, 2)] as Rule[]);
    expect(plan).toEqual([]);
  });
});
