import { homedir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import type { Rule, RuleState } from '../shared/types.js';
import { BlertError } from '../shared/errors.js';
import { systemClock, iso, type Clock } from '../shared/clock.js';
import { readJson, writeJson, type FileSpec } from './jsonfile.js';
import { withLock, type LockOptions } from './lock.js';

export const SCHEMA_VERSION = 1;

export interface Config {
  schemaVersion: number;
  soundEnabled: boolean;
  language: 'ko';
  runMode: 'foreground';
  disclaimerAccepted: boolean;
  presets: { slug: string; version: number }[];
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
  /** 규칙이 바뀌면 호출된다. runtime이 rules.changed 이벤트로 바꿔 발행한다. */
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

  // --- state (규칙과 분리 저장, B8) ---
  async loadStates(): Promise<RuleState[]> {
    return (await readJson(this.stateSpec)).states;
  }
  saveStates(states: RuleState[]): Promise<void> {
    return this.locked(() => writeJson(this.stateSpec, { schemaVersion: SCHEMA_VERSION, states }));
  }
}
