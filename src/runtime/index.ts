import { join } from 'node:path';
import { BlertError, ExitCode, type ExitCodeValue } from '../shared/errors.js';
import { EventBus } from '../shared/bus.js';
import { iso, systemClock, type Clock } from '../shared/clock.js';
import { Logger, mask } from '../shared/logger.js';
import type { Alert, Market } from '../shared/types.js';
import { t } from '../i18n/index.js';
import { Store, type PidFile } from '../store/index.js';
import { Engine } from '../engine/index.js';
import { BinanceFeed, planSubscriptions, retryDelayMs, type FeedOptions, type StreamPlan } from '../binance/index.js';
import type { Notifier } from '../notify/index.js';
import { FileLogSink } from './logsink.js';
import { SLEEP_CHECK_MS, SLEEP_THRESHOLD_MS, SleepDetector } from './sleep.js';

const LOG = 'runtime';
const MARKETS: Market[] = ['spot', 'futures'];
/** B10: 내부 오류로 감시 코어를 다시 시작하다가 이만큼 연속되면 종료한다 */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** 생존 신호가 이만큼 끊기면 잠금 파일의 주인이 멈춘 것으로 본다 (프로세스 번호 재사용 대비) */
export const HEARTBEAT_STALE_MS = 60_000;

export interface Timing {
  /** 시작할 때 모든 연결이 열리기를 기다리는 시간. 넘으면 연결 불가로 보고 종료 코드 3 */
  startupTimeoutMs: number;
  sleepCheckMs: number;
  sleepThresholdMs: number;
  /** 시작 뒤 이 시간이 지나도 데이터가 없는 심볼을 한 번 안내한다 */
  silenceMs: number;
  /** 이만큼 오류 없이 돌았으면 '연속' 실패 횟수를 0으로 되돌린다 */
  healthyMs: number;
  /** 잠금 파일(blert.pid)의 생존 신호 갱신 간격 */
  heartbeatMs: number;
}

export const DEFAULT_TIMING: Timing = {
  startupTimeoutMs: 10_000,
  sleepCheckMs: SLEEP_CHECK_MS,
  sleepThresholdMs: SLEEP_THRESHOLD_MS,
  silenceMs: 30_000,
  healthyMs: 60_000,
  heartbeatMs: 15_000,
};

export interface RuntimeIo {
  out(text: string): void;
  err(text: string): void;
}

/** 종료 신호와 처리되지 않은 예외를 받는 대상. 기본은 process, 테스트에서는 가짜를 쓴다. */
export interface ProcessLike {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off(event: string, handler: (...args: unknown[]) => void): unknown;
}

export interface RuntimeOptions {
  /** 설정 폴더 (B8) */
  dir: string;
  io: RuntimeIo;
  /** 로거를 받아 알림 출력기를 만든다 (알림 전체를 로그에 남기기 위함) */
  makeNotifier: (logger: Logger) => Notifier;
  verbose?: boolean;
  clock?: Clock;
  timing?: Partial<Timing>;
  /** binance 연결 옵션 덮어쓰기 (테스트용 가짜 소켓 등) */
  feedOptions?: Partial<Omit<FeedOptions, 'bus'>>;
  process?: ProcessLike;
}

type StartResult = { ok: true } | { ok: false; failedMarkets: string[] };

/**
 * 감시 코어: 모듈을 조립하고 시작·종료·절전 복귀·내부 오류 복구를 맡는다 (B9, B10).
 * 포그라운드 실행(run)이 이것을 그대로 쓰고, 이후 데몬·서비스도 같은 코어를 띄우는 방식만 다르다.
 */
export class Runtime {
  /** 모듈 간 통신 버스. 테스트가 오류를 주입할 수 있게 공개한다 */
  readonly bus: EventBus;
  readonly logger: Logger;
  private readonly clock: Clock;
  private readonly timing: Timing;
  private readonly store: Store;
  private readonly notifier: Notifier;
  private engine?: Engine;
  private feed?: BinanceFeed;
  private offEngine?: () => void;
  private sleep?: SleepDetector;
  private plan: StreamPlan[] = [];
  private seen = new Set<string>();
  private silenceTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private lockHeld = false;
  /** 이전 실행이 정상 종료하지 못했다면 그 기록 */
  private previousRun?: PidFile;
  /** 시작할 때 연결하지 못해 아직 감시하지 못하는 시장 */
  private degraded = new Set<Market>();
  private stopping = false;
  private restarting = false;
  private consecutive = 0;
  private lastFailureAt = 0;
  private finish!: (code: ExitCodeValue) => void;
  /** 감시가 끝나면 종료 코드로 이행된다 */
  readonly exit: Promise<ExitCodeValue>;

  constructor(private o: RuntimeOptions) {
    this.clock = o.clock ?? systemClock;
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
    this.exit = new Promise((resolve) => (this.finish = resolve));
    this.logger = new Logger(new FileLogSink(join(o.dir, 'logs'), this.clock), o.verbose ? 'debug' : 'info', () => this.clock.now());
    this.bus = new EventBus({ onError: (e) => this.onInternalError(e) });
    this.notifier = o.makeNotifier(this.logger);
    this.store = new Store(o.dir, {
      clock: this.clock,
      onRulesChanged: (ruleIds) => this.bus.emit({ type: 'rules.changed', ts: iso(this.clock.now()), ruleIds }),
    });
    this.wire();
  }

  /** 포그라운드 실행. 종료 코드를 돌려준다 (AC-20). */
  async runForeground(): Promise<ExitCodeValue> {
    const off = this.installProcessHandlers();
    try {
      const started = await this.start();
      if (!started.ok) {
        await this.stop(ExitCode.connection, false);
        this.o.io.err(t('err.startConnect', { streams: started.failedMarkets.join(', ') }));
        return ExitCode.connection;
      }
      return await this.exit;
    } finally {
      off();
    }
  }

  /** B9 시작: 설정 로드 → 스키마 확인·마이그레이션 → 중복 실행 확인 → 스트림 연결 → 감시 시작 알림 */
  async start(): Promise<StartResult> {
    const [rules, config] = await Promise.all([this.store.loadRules(), this.store.loadConfig(), this.store.loadStates()]);
    if (!config.disclaimerAccepted) throw new BlertError('err.runNeedInit');
    const enabled = rules.filter((r) => r.enabled);
    if (enabled.length === 0) throw new BlertError('err.runNoRules');

    const lock = await this.store.acquireRunLock({ pid: process.pid, now: this.clock.now(), staleMs: HEARTBEAT_STALE_MS });
    if (!lock.ok) throw new BlertError('err.runAlready', { pid: lock.holder.pid });
    this.lockHeld = true;
    this.previousRun = lock.previous;
    this.armHeartbeat();

    this.logger.info(LOG, `starting with ${enabled.length} rules`);
    this.o.io.out(t('run.connecting'));
    try {
      await this.build();
    } catch (e) {
      await this.releaseLock();
      throw e;
    }

    const failed = await this.waitOpen();
    if (failed.length > 0 && failed.length >= this.neededMarkets().length) {
      this.logger.error(LOG, `could not connect: ${failed.join(', ')}`);
      return { ok: false, failedMarkets: failed };
    }

    const count = (market: Market) => enabled.filter((r) => r.market === market).length;
    const alert: Alert = {
      ruleId: 0,
      kind: 'account', // 중립 표시. 시작 알림은 소리가 없다 (B7)
      sound: 'off',
      titleKey: 'alert.start.title',
      params: { total: enabled.length, spot: count('spot'), futures: count('futures') },
      firedAt: iso(this.clock.now()),
    };
    this.notifier.announce(alert);
    this.o.io.out(t('run.started'));
    // 일부 시장만 연결된 채로 시작하면 감시하지 못하는 규칙을 반드시 알린다 (NFR-REL-02). 연결은 계속 재시도한다.
    for (const market of failed as Market[]) this.reportDegraded(market, count(market));
    this.reportUncleanExit();
    this.silenceTimer = setTimeout(() => this.reportSilence(), this.timing.silenceMs);
    return { ok: true };
  }

  /** B9 종료: 새 이벤트 수신 중단 → 상태 저장 → 연결 종료 */
  async stop(code: ExitCodeValue = ExitCode.ok, announce = true): Promise<void> {
    if (this.stopping) return void (await this.exit);
    this.stopping = true;
    clearTimeout(this.silenceTimer);
    await this.teardown();
    await this.notifier.flush();
    await this.releaseLock(); // PID 파일 삭제 (B9)
    this.logger.info(LOG, `stopped (exit ${code})`);
    if (announce) this.o.io.out(t('run.stopped'));
    this.finish(code);
  }

  // ---- 조립 ----

  /** 이벤트 버스에 붙는 상시 구독. 코어를 다시 시작해도 유지된다. */
  private wire(): void {
    this.notifier.attach(this.bus);
    this.bus.on('conn.status', (e) => {
      this.logger.info(LOG, `connection ${e.stream}: ${e.state} (attempt ${e.attempt})`);
      if (e.state === 'open') this.o.io.out(t('run.connOpen', { stream: e.stream }));
      const market = e.stream.split('#')[0] as Market;
      if (e.state === 'open' && this.degraded.delete(market)) this.reportRecovered(market);
      if (e.state === 'retrying') {
        this.o.io.out(t('run.connRetry', { stream: e.stream, attempt: e.attempt, seconds: retryDelayMs(e.attempt) / 1000 }));
      }
    });
    this.bus.on('conn.gap', (e) => {
      this.logger.warn(LOG, `monitoring gap (${e.reason}${e.ongoing ? ', ongoing' : ''}): ${e.from} ~ ${e.to}`);
    });
    this.bus.on('rules.changed', () => void this.refreshPlan());
    this.bus.on('market.ticker', (e) => void this.seen.add(`${e.market}:${e.symbol}`));
    this.bus.on('market.funding', (e) => void this.seen.add(`futures:${e.symbol}`));
  }

  /** 엔진·연결·절전 감지를 만든다. 내부 오류 복구 때도 다시 쓴다. */
  private async build(): Promise<void> {
    const engine = new Engine({ store: this.store, logger: this.logger });
    await engine.init();
    this.offEngine = engine.attach(this.bus);
    this.engine = engine;
    this.feed = new BinanceFeed({ bus: this.bus, clock: this.clock, logger: this.logger, ...this.o.feedOptions });
    this.sleep = new SleepDetector({
      clock: this.clock,
      checkMs: this.timing.sleepCheckMs,
      thresholdMs: this.timing.sleepThresholdMs,
      onWake: (from, to) => this.onWake(from, to),
    });
    this.sleep.start();
    await this.refreshPlan();
  }

  private async teardown(): Promise<void> {
    this.sleep?.stop();
    this.feed?.stop();
    this.offEngine?.();
    try {
      await this.engine?.flush(); // 상태 저장
    } catch (e) {
      this.logger.error(LOG, `flush failed: ${String(e)}`);
    }
    this.sleep = this.feed = this.engine = this.offEngine = undefined;
  }

  /** 규칙이 바뀌면 필요한 스트림만 구독하도록 갱신한다 (B5) */
  private async refreshPlan(): Promise<void> {
    try {
      const rules = await this.store.loadRules();
      if (!this.feed || this.stopping) return;
      this.plan = planSubscriptions(rules);
      this.feed.update(this.plan);
    } catch (e) {
      this.logger.error(LOG, `refresh subscriptions failed: ${String(e)}`);
    }
  }

  /** 필요한 시장의 연결이 모두 열리기를 기다린다. 열리지 못한 시장 이름을 돌려준다(전부 열렸으면 빈 배열). */
  private neededMarkets(): Market[] {
    return MARKETS.filter((m) => this.plan.some((p) => p.market === m));
  }

  private waitOpen(): Promise<string[]> {
    const needed = this.neededMarkets();
    const notOpen = () =>
      needed.filter((m) => {
        const conns = (this.feed?.status ?? []).filter((s) => s.stream === m || s.stream.startsWith(`${m}#`));
        return conns.length === 0 || conns.some((s) => s.state !== 'open');
      });
    return new Promise((resolve) => {
      if (notOpen().length === 0) return resolve([]);
      const off = this.bus.on('conn.status', () => {
        if (notOpen().length === 0) {
          clearTimeout(timer);
          off();
          resolve([]);
        }
      });
      const timer = setTimeout(() => {
        off();
        resolve(notOpen());
      }, this.timing.startupTimeoutMs);
    });
  }

  // ---- 실행 잠금·생존 신호 (blert.pid) ----

  private armHeartbeat(): void {
    const tick = () => {
      this.store.touchRunLock(process.pid, this.clock.now()).catch((e) => this.logger.error(LOG, `heartbeat failed: ${String(e)}`));
      this.heartbeatTimer = setTimeout(tick, this.timing.heartbeatMs);
    };
    this.heartbeatTimer = setTimeout(tick, this.timing.heartbeatMs);
  }

  private async releaseLock(): Promise<void> {
    clearTimeout(this.heartbeatTimer);
    if (!this.lockHeld) return;
    this.lockHeld = false;
    await this.store.releaseRunLock(process.pid).catch((e) => this.logger.error(LOG, `release lock failed: ${String(e)}`));
  }

  /** 이전 실행이 정상 종료하지 못했으면, 마지막 생존 신호부터 지금까지를 감시 중단 구간으로 알린다 (NFR-REL-02) */
  private reportUncleanExit(): void {
    const prev = this.previousRun;
    if (!prev || Number.isNaN(Date.parse(prev.heartbeatAt))) return;
    const to = this.clock.now();
    this.logger.warn(LOG, `previous run (pid ${prev.pid}) did not exit cleanly, last seen ${prev.heartbeatAt}`);
    this.bus.emit({ type: 'conn.gap', ts: iso(to), from: prev.heartbeatAt, to: iso(to), reason: 'exit' });
  }

  // ---- 일부 시장 연결 실패 ----

  private reportDegraded(market: Market, ruleCount: number): void {
    this.degraded.add(market);
    this.logger.warn(LOG, `${market} not connected, ${ruleCount} rules are not monitored yet`);
    this.o.io.out(t('run.partial', { market: t(`market.${market}`), count: ruleCount }));
    this.notifier.announce({
      ruleId: 0,
      kind: 'warn',
      titleKey: 'alert.partial.title',
      params: { market, count: ruleCount },
      firedAt: iso(this.clock.now()),
    });
  }

  private reportRecovered(market: Market): void {
    this.logger.info(LOG, `${market} connection recovered`);
    this.o.io.out(t('run.partialRecovered', { market: t(`market.${market}`) }));
    this.notifier.announce({ ruleId: 0, kind: 'account', sound: 'off', titleKey: 'alert.recovered.title', params: { market }, firedAt: iso(this.clock.now()) });
  }

  // ---- 절전 복귀 (FR-RUN-02, NFR-REL-02) ----

  private onWake(from: number, to: number): void {
    this.logger.warn(LOG, `system wake detected, gap ${iso(from)} ~ ${iso(to)}`);
    this.feed?.reconnectAll(); // 모든 연결을 다시 맺고, 끊긴 사이 1분봉을 보충한다
    this.bus.emit({ type: 'conn.gap', ts: iso(to), from: iso(from), to: iso(to), reason: 'sleep' });
  }

  // ---- 데이터가 오지 않는 심볼 안내 ----

  private reportSilence(): void {
    const label = (market: Market, symbol: string) => `${t(`market.${market}`)} ${symbol}`;
    const missing = new Set<string>();
    for (const p of this.plan) {
      if ((p.ticker && !this.seen.has(`${p.market}:${p.symbol}`)) || (p.funding && !this.seen.has(`futures:${p.symbol}`))) {
        missing.add(label(p.market, p.symbol));
      }
    }
    for (const s of this.feed?.invalidSymbols ?? []) missing.add(label(s.market, s.symbol));
    if (missing.size === 0) return;
    const list = [...missing];
    const shown = list.slice(0, 5).join(', ') + (list.length > 5 ? ` +${list.length - 5}` : '');
    this.logger.warn(LOG, `no data for: ${list.join(', ')}`);
    this.o.io.out(t('run.noData', { symbols: shown }));
  }

  // ---- 내부 오류 (B10) ----

  /** 로그를 남기고 감시 코어를 다시 시작한다. 연속 3회면 종료 코드 9로 끝낸다. */
  onInternalError(e: unknown): void {
    if (this.stopping) return;
    const detail = mask(e instanceof Error ? e.message : String(e));
    this.logger.error(LOG, `internal error: ${detail}${e instanceof Error && e.stack ? ` | ${e.stack.split('\n').slice(1, 3).join(' ').trim()}` : ''}`);
    const now = this.clock.now();
    if (now - this.lastFailureAt > this.timing.healthyMs) this.consecutive = 0;
    this.lastFailureAt = now;
    this.consecutive++;
    if (this.consecutive >= MAX_CONSECUTIVE_FAILURES) {
      this.o.io.err(t('err.runInternal', { detail, logsDir: join(this.o.dir, 'logs') }));
      void this.stop(ExitCode.internal, false);
      return;
    }
    if (this.restarting) return;
    this.o.io.err(t('run.restarting', { count: this.consecutive, max: MAX_CONSECUTIVE_FAILURES, detail }));
    void this.restart();
  }

  private async restart(): Promise<void> {
    this.restarting = true;
    try {
      await this.teardown();
      if (!this.stopping) await this.build();
    } catch (e) {
      this.restarting = false;
      this.onInternalError(e);
    } finally {
      this.restarting = false;
    }
  }

  private installProcessHandlers(): () => void {
    const proc = this.o.process ?? process;
    const onSignal = () => void this.stop(ExitCode.ok);
    const onError = (e: unknown) => this.onInternalError(e);
    const signals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
    for (const s of signals) proc.on(s, onSignal);
    proc.on('uncaughtException', onError);
    proc.on('unhandledRejection', onError);
    return () => {
      for (const s of signals) proc.off(s, onSignal);
      proc.off('uncaughtException', onError);
      proc.off('unhandledRejection', onError);
    };
  }
}

export interface RunnerDeps extends Omit<RuntimeOptions, 'verbose'> {}

/** cli의 `run` 명령이 부르는 진입점 (cli는 runtime을 직접 알 수 없어 포트로 연결한다, B2) */
export function createRunner(deps: RunnerDeps): { run(opts: { verbose: boolean }): Promise<number> } {
  return {
    run: ({ verbose }) => new Runtime({ ...deps, verbose }).runForeground(),
  };
}
