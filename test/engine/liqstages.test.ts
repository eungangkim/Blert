import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine/index.js';
import { DEFAULT_REPEAT } from '../../src/shared/defaults.js';
import { render } from '../../src/notify/render.js';
import type { Alert, Rule } from '../../src/shared/types.js';
import { MIN, T0, position, rule } from './helpers.js';

const fire = (engine: Engine, ...events: Parameters<Engine['handle']>[0][]): Alert[] => events.flatMap((e) => engine.handle(e));
const staged = (stages: number[], repeat = DEFAULT_REPEAT.liq): Rule => rule({ type: 'liq', pct: stages[0]!, stages }, repeat, { market: 'futures' });
/** 마크 100,000 고정, 롱 청산가를 조절해 거리를 정확히 d%로 만든다 */
const dist = (ts: number, d: number) => position(ts, 'LONG', 1, 100_000 * (1 - d / 100), 100_000);
const stageOf = (a: Alert) => ({ stage: a.params.stage, stages: a.params.stages, level: a.params.level });

describe('engine 단계별 청산 경고 (FR-ALERT-06, D-118~D-120)', () => {
  it('AC-103 거리 11 → 9 → 4 → 1.5 → 9 → 12 → 9%: 단계가 깊어질 때마다 즉시 알리고, 얕아질 땐 조용히, 완전히 벗어나면 재무장', () => {
    const engine = new Engine();
    engine.setRules([staged([10, 5, 2])]);
    const steps: [number, number, ReturnType<typeof stageOf> | null][] = [
      [11, 0, null], // 첫 단계 밖
      [9, 1, { stage: 1, stages: 3, level: 'caution' }],
      [4, 2, { stage: 2, stages: 3, level: 'danger' }], // 쿨다운(5분) 안인데도 즉시
      [1.5, 3, { stage: 3, stages: 3, level: 'urgent' }],
      [9, 4, null], // 얕은 단계로 복귀: 알림 없음
      [12, 5, null], // 첫 임계값의 1.1배(11)를 넘어 재무장
      [9, 6, { stage: 1, stages: 3, level: 'caution' }],
    ];
    for (const [d, minute, expected] of steps) {
      const alerts = fire(engine, dist(T0 + minute * 10_000, d)); // 모두 1분 안: 쿨다운이 막지 못한다는 것도 함께 확인
      expect(alerts.map(stageOf), `거리 ${d}%`).toEqual(expected ? [expected] : []);
    }
  });

  it('AC-103 알림은 warn 소리 하나를 쓰고 제목에 단계와 심각도, 본문에 그 단계의 기준을 담는다 (D-120)', () => {
    const engine = new Engine();
    engine.setRules([staged([10, 5, 2])]);
    const [a] = fire(engine, dist(T0, 4));
    expect(a).toMatchObject({ kind: 'warn', titleKey: 'alert.liq.stage.title' });
    expect(render(a!)).toEqual({ title: 'BTC 선물 청산 위험 2/3단계 · 청산가까지 4.0%', body: '롱 청산가 96,000 · 마크 100,000 USDT · 기준 5% 이내' });
  });

  it('AC-103 처음부터 깊은 단계에 있으면 그 단계로 한 번에 알린다', () => {
    const engine = new Engine();
    engine.setRules([staged([10, 5, 2])]);
    expect(fire(engine, dist(T0, 1)).map(stageOf)).toEqual([{ stage: 3, stages: 3, level: 'urgent' }]);
  });

  it('AC-104 같은 단계에 머무르면 쿨다운(5분)마다만 반복한다', () => {
    const engine = new Engine();
    engine.setRules([staged([10, 5])]);
    expect(fire(engine, dist(T0, 8))).toHaveLength(1);
    expect(fire(engine, dist(T0 + MIN, 8), dist(T0 + 4 * MIN, 7))).toHaveLength(0);
    expect(fire(engine, dist(T0 + 5 * MIN, 8))).toHaveLength(1);
  });

  it('AC-104 규칙에 지정한 쿨다운을 따른다', () => {
    const engine = new Engine();
    engine.setRules([staged([10, 5], { kind: 'cooldown', ms: 10 * MIN })]);
    expect(fire(engine, dist(T0, 8))).toHaveLength(1);
    expect(fire(engine, dist(T0 + 6 * MIN, 8))).toHaveLength(0);
    expect(fire(engine, dist(T0 + 10 * MIN, 8))).toHaveLength(1);
  });

  it('AC-104 얕은 단계로 돌아왔다가 다시 깊어지면 쿨다운과 무관하게 알린다', () => {
    const engine = new Engine();
    engine.setRules([staged([10, 5, 2])]);
    fire(engine, dist(T0, 4)); // 2단계
    expect(fire(engine, dist(T0 + 1000, 8))).toHaveLength(0); // 1단계로 복귀(조용히)
    expect(fire(engine, dist(T0 + 2000, 4)).map(stageOf)).toEqual([{ stage: 2, stages: 3, level: 'danger' }]);
  });

  it('AC-104 첫 임계값과 1.1배 사이(10~11%)로 벗어나는 것은 재무장이 아니다', () => {
    const engine = new Engine();
    engine.setRules([staged([10, 5])]);
    expect(fire(engine, dist(T0, 9))).toHaveLength(1);
    expect(fire(engine, dist(T0 + 1000, 10.5))).toHaveLength(0);
    expect(fire(engine, dist(T0 + 2000, 9))).toHaveLength(0); // 아직 같은 1단계, 쿨다운 안
    expect(engine.getStates()[0]!.liqStage).toBe(1);
    expect(fire(engine, dist(T0 + 3000, 11.5))).toHaveLength(0);
    expect(engine.getStates()[0]!.liqStage).toBe(0);
    expect(fire(engine, dist(T0 + 4000, 9))).toHaveLength(1); // 재무장 뒤 첫 단계 알림
  });

  it('AC-104 진행 중인 단계가 상태(liqStage)에 기록되고 저장된 상태에서 이어진다', () => {
    const rules = [staged([10, 5])];
    const engine = new Engine();
    engine.setRules(rules);
    fire(engine, dist(T0, 4));
    const saved = engine.getStates();
    expect(saved[0]).toMatchObject({ ruleId: rules[0]!.id, liqStage: 2 });
    const restarted = new Engine();
    restarted.setRules(rules, saved);
    expect(fire(restarted, dist(T0 + MIN, 4))).toHaveLength(0); // 같은 단계, 쿨다운 안
  });

  it('AC-104 stages가 없는 규칙은 기존 동작 그대로다 (단계 문구 없음, liqStage 없음)', () => {
    const engine = new Engine();
    engine.setRules([rule({ type: 'liq', pct: 5 }, DEFAULT_REPEAT.liq, { market: 'futures' })]);
    const [a] = fire(engine, dist(T0, 4));
    expect(a).toMatchObject({ titleKey: 'alert.liq.title' });
    expect(engine.getStates()[0]!.liqStage).toBeUndefined();
  });

  it('AC-104 포지션이 없으면 단계 규칙도 알리지 않는다', () => {
    const engine = new Engine();
    engine.setRules([staged([10, 5])]);
    expect(fire(engine, position(T0, 'LONG', 0, 0, 100_000))).toHaveLength(0);
  });
});
