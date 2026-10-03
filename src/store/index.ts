import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, promises as fs, statSync, watch as fsWatch } from 'node:fs';
import type { Rule, RuleState } from '../shared/types.js';
import { BlertError } from '../shared/errors.js';
import { systemClock, iso, type Clock } from '../shared/clock.js';
import { atomicWrite, readJson, writeJson, type FileSpec } from './jsonfile.js';
import { PID_SCHEMA_VERSION, holderIsRunning, readPidFile, writePidFile, type AcquireResult, type PidFile } from './pid.js';
import { withLock, type LockOptions } from './lock.js';

export const SCHEMA_VERSION = 1;

export type { PidFile, AcquireResult } from './pid.js';
export { pidAlive } from './pid.js';

export const STATUS_SCHEMA_VERSION = 1;

/**
 * 데몬 상태 파일(blert.status.json, D-58·D-59). 데몬이 5초마다 갱신하고, `blert start`가 준비 완료를 기다릴 때와
 * `blert status`가 읽는다. 키·시크릿은 담지 않는다.
 */
export interface StatusFile {
  schemaVersion: number;
  pid: number;
  /** starting: 연결 중, ready: 감시 시작, failed: 시작하지 못함, stopping: 종료 중 */
  state: 'starting' | 'ready' | 'failed' | 'stopping';
  startedAt: string;
  updatedAt: string;
  rules: { spot: number; futures: number };
  connections: { stream: string; state: string }[];
  /** 가장 최근 감시 중단 구간 */
  lastGap?: { from: string; to: string; reason: string; ongoing?: boolean };
  /** state가 failed일 때: 화면에 보여 줄 오류 문구 키와 값, 종료 코드 */
  failure?: { messageKey: string; params: Record<string, string | number>; exitCode: number };
}

export type RunLockState = { state: 'none' } | { state: 'running'; file: PidFile } | { state: 'stale'; file: PidFile };

export interface Config {
  schemaVersion: number;
  soundEnabled: boolean;
  language: 'ko';
  runMode: 'foreground';
  disclaimerAccepted: boolean;
  presets: { slug: string; version: number }[];
  /** 키체인에 저장한 키의 참조 이름. 키·시크릿은 파일에 저장하지 않는다 (B6) */
  keyRef?: string;
}
export interface RulesFile {
  schemaVersion: number;
  nextId: number;
  rules: Rule[];
}
export interface StateFile {
  schemaVersion: number;
  states: RuleState[];
}

/** 설정 폴더: Windows %APPDATA%\blert, 그 외 ~/.config/blert (B8) */
export function defaultDir(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'blert');
  return join(homedir(), '.config', 'blert');
}

export interface StoreOptions {
  clock?: Clock;
  lock?: LockOptions;
  /** 규칙이 바뀌면 호출된다. runtime이 rules.changed 이벤트로 바꿔 발행한다. (다른 프로세스의 변경은 watchRules가 알린다) */
  onRulesChanged?: (ruleIds: number[]) => void;
}

export class Store {
  private readonly clock: Clock;
  private readonly configSpec: FileSpec<Config>;
  private readonly rulesSpec: FileSpec<RulesFile>;
  private readonly stateSpec: FileSpec<StateFile>;

  constructor(readonly dir: string = defaultDir(), private opts: StoreOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.configSpec = {
      path: join(dir, 'config.json'), name: 'config.json', current: SCHEMA_VERSION, steps: [],
      defaults: () => ({ schemaVersion: SCHEMA_VERSION, soundEnabled: true, language: 'ko', runMode: 'foreground', disclaimerAccepted: false, presets: [] }),
    };
    this.rulesSpec = {
      path: join(dir, 'rules.json'), name: 'rules.json', current: SCHEMA_VERSION, steps: [],
      defaults: () => ({ schemaVersion: SCHEMA_VERSION, nextId: 1, rules: [] }),
    };
    this.stateSpec = {
      path: join(dir, 'state.json'), name: 'state.json', current: SCHEMA_VERSION, steps: [],
      defaults: () => ({ schemaVersion: SCHEMA_VERSION, states: [] }),
    };
  }

  get logsDir(): string {
    return join(this.dir, 'logs');
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.dir, { recursive: true });
    return withLock(join(this.dir, '.lock'), fn, this.opts.lock);
  }

  // --- config ---
  loadConfig(): Promise<Config> {
    return readJson(this.configSpec);
  }
  updateConfig(mutate: (c: Config) => void): Promise<Config> {
    return this.locked(async () => {
      const c = await readJson(this.configSpec);
      mutate(c);
      await writeJson(this.configSpec, c);
      return c;
    });
  }

  // --- rules ---
  async loadRules(): Promise<Rule[]> {
    return (await readJson(this.rulesSpec)).rules;
  }

  /** ID와 createdAt은 store가 채운다. 한 번의 잠금으로 여러 개를 추가한다. */
  addRules(drafts: Omit<Rule, 'id' | 'createdAt'>[]): Promise<Rule[]> {
    return this.locked(async () => {
      const f = await readJson(this.rulesSpec);
      const added = drafts.map((d): Rule => ({ ...d, id: f.nextId++, createdAt: iso(this.clock.now()) }));
      f.rules.push(...added);
      await writeJson(this.rulesSpec, f);
      this.opts.onRulesChanged?.(added.map((r) => r.id));
      return added;
    });
  }

  /** 지정한 ID(또는 all)의 규칙을 바꾼다. 없는 ID면 아무것도 바꾸지 않고 오류. */
  private changeRules(target: number | 'all', apply: (f: RulesFile, hit: Rule[]) => void): Promise<number[]> {
    return this.locked(async () => {
      const f = await readJson(this.rulesSpec);
      const hit = target === 'all' ? [...f.rules] : f.rules.filter((r) => r.id === target);
      if (target !== 'all' && hit.length === 0) throw new BlertError('store.ruleNotFound', { id: target });
      apply(f, hit);
      await writeJson(this.rulesSpec, f);
      const ids = hit.map((r) => r.id);
      if (ids.length) this.opts.onRulesChanged?.(ids);
      return ids;
    });
  }

  setEnabled(target: number | 'all', enabled: boolean): Promise<number[]> {
    return this.changeRules(target, (_f, hit) => hit.forEach((r) => (r.enabled = enabled)));
  }

  deleteRules(target: number | 'all'): Promise<number[]> {
    return this.changeRules(target, (f, hit) => {
      const ids = new Set(hit.map((r) => r.id));
      f.rules = f.rules.filter((r) => !ids.has(r.id));
    });
  }

  /** 프리셋 제거용: 해당 출처의 규칙만 삭제 */
  deleteBySource(source: Rule['source']): Promise<number[]> {
    return this.locked(async () => {
      const f = await readJson(this.rulesSpec);
      const ids = f.rules.filter((r) => r.source === source).map((r) => r.id);
      f.rules = f.rules.filter((r) => r.source !== source);
      await writeJson(this.rulesSpec, f);
      if (ids.length) this.opts.onRulesChanged?.(ids);
      return ids;
    });
  }

  // --- 실행 잠금·생존 신호 (blert.pid) ---
  private get pidPath(): string {
    return join(this.dir, 'blert.pid');
  }

  readRunLock(): Promise<PidFile | undefined> {
    return readPidFile(this.pidPath);
  }

  /**
   * 실행 잠금을 잡는다. 이미 실행 중인 주인이 있으면 거부(holder)하고, 주인이 죽었거나 생존 신호가 끊긴
   * 낡은 파일이면 이전 실행(previous)을 돌려주며 가져온다 — 이전 실행이 정상 종료하지 못했다는 뜻이다.
   */
  acquireRunLock(o: { pid: number; now: number; staleMs: number; mode?: 'foreground' | 'daemon' }): Promise<AcquireResult> {
    return this.locked(async () => {
      const existing = await readPidFile(this.pidPath);
      if (existing && holderIsRunning(existing, o.now, o.staleMs)) return { ok: false, holder: existing };
      const at = iso(o.now);
      await writePidFile(this.pidPath, { schemaVersion: PID_SCHEMA_VERSION, pid: o.pid, startedAt: at, heartbeatAt: at, mode: o.mode ?? 'foreground' });
      return { ok: true, previous: existing };
    });
  }

  /** 생존 신호를 갱신한다. 파일의 주인이 내가 아니면 건드리지 않는다. */
  async touchRunLock(pid: number, nowMs: number): Promise<void> {
    const file = await readPidFile(this.pidPath);
    if (file?.pid === pid) await writePidFile(this.pidPath, { ...file, heartbeatAt: iso(nowMs) });
  }

  /** 정상 종료: 내 잠금 파일을 지운다 (B9) */
  async releaseRunLock(pid: number): Promise<void> {
    const file = await readPidFile(this.pidPath);
    if (file?.pid === pid) await fs.rm(this.pidPath, { force: true });
  }

  /** 잠금 파일의 주인이 지금 실행 중인지, 낡았는지(비정상 종료), 없는지 (D-61). 파일은 건드리지 않는다. */
  async inspectRunLock(nowMs: number, staleMs: number): Promise<RunLockState> {
    const file = await readPidFile(this.pidPath);
    if (!file) return { state: 'none' };
    return holderIsRunning(file, nowMs, staleMs) ? { state: 'running', file } : { state: 'stale', file };
  }

  // --- 데몬 상태 파일 (blert.status.json, D-58) ---
  private get statusPath(): string {
    return join(this.dir, 'blert.status.json');
  }

  async readStatus(): Promise<StatusFile | undefined> {
    try {
      const d = JSON.parse(await fs.readFile(this.statusPath, 'utf8')) as Partial<StatusFile>;
      if (typeof d.pid !== 'number' || typeof d.state !== 'string') return undefined;
      return d as StatusFile;
    } catch {
      return undefined; // 없거나 깨졌으면 상태 없음
    }
  }

  writeStatus(status: Omit<StatusFile, 'schemaVersion'>): Promise<void> {
    return atomicWrite(this.statusPath, JSON.stringify({ schemaVersion: STATUS_SCHEMA_VERSION, ...status }, null, 2) + '\n');
  }

  /** 내 상태 파일만 지운다 (다른 데몬의 것은 건드리지 않는다) */
  async clearStatus(pid: number): Promise<void> {
    const s = await this.readStatus();
    if (s?.pid === pid) await fs.rm(this.statusPath, { force: true });
  }

  // --- 데몬 종료 요청 (blert.stop, D-57) ---
  private get stopPath(): string {
    return join(this.dir, 'blert.stop');
  }

  requestStop(nowMs: number): Promise<void> {
    return atomicWrite(this.stopPath, JSON.stringify({ schemaVersion: 1, requestedAt: iso(nowMs) }) + '\n');
  }

  async stopRequested(): Promise<boolean> {
    try {
      await fs.access(this.stopPath);
      return true;
    } catch {
      return false;
    }
  }

  clearStopRequest(): Promise<void> {
    return fs.rm(this.stopPath, { force: true });
  }

  // --- 다른 프로세스의 규칙 변경 감시 (D-56) ---
  /**
   * rules.json이 바뀌면(다른 터미널의 `blert add` 등) onChange를 부른다. 파일 변경 이벤트를 디바운스로 모아 처리하고,
   * 이벤트를 놓쳐도 pollMs마다 수정 시각·크기를 확인한다. 포트나 소켓은 열지 않는다 (NFR-SEC-02). 반환값은 감시 해제 함수.
   */
  watchRules(onChange: () => void, o: { pollMs?: number; debounceMs?: number } = {}): () => void {
    const file = join(this.dir, 'rules.json');
    const signature = () => {
      try {
        const st = statSync(file);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return 'none';
      }
    };
    let last = signature();
    const check = () => {
      const now = signature();
      if (now === last) return;
      last = now;
      onChange();
    };
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let watcher: ReturnType<typeof fsWatch> | undefined;
    try {
      mkdirSync(this.dir, { recursive: true });
      watcher = fsWatch(this.dir, (_event, name) => {
        if (name !== null && name !== undefined && String(name) !== 'rules.json') return;
        clearTimeout(debounce);
        debounce = setTimeout(check, o.debounceMs ?? 200);
        debounce.unref();
      });
      watcher.on('error', () => {}); // 감시 기능이 꺼져도 주기 확인이 이어진다
      watcher.unref();
    } catch {
      watcher = undefined; // 파일 변경 이벤트를 쓸 수 없는 환경: 주기 확인만 한다
    }
    const poll = setInterval(check, o.pollMs ?? 5000);
    poll.unref();
    return () => {
      clearTimeout(debounce);
      clearInterval(poll);
      watcher?.close();
    };
  }

  // --- state (규칙과 분리 저장, B8) ---
  async loadStates(): Promise<RuleState[]> {
    return (await readJson(this.stateSpec)).states;
  }
  saveStates(states: RuleState[]): Promise<void> {
    return this.locked(() => writeJson(this.stateSpec, { schemaVersion: SCHEMA_VERSION, states }));
  }
}
