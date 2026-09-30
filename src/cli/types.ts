import type { Store } from '../store/index.js';
import type { PresetService } from '../presets/index.js';

export type { PresetService };

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** 질문을 출력하고 한 줄을 받는다. 입력이 끝났으면 null. */
  ask(question: string): Promise<string | null>;
}

export interface Deps {
  store: Store;
  presets: PresetService;
  io: Io;
}

export interface ParsedArgs {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

export interface Ctx {
  args: ParsedArgs;
  /** 명령 이름 뒤의 위치 인자 */
  rest: string[];
  deps: Deps;
}

export interface Command {
  name: string;
  /** 도움말의 사용법 줄 (i18n 키) */
  usageKeys: string[];
  /** 이 명령이 받는 옵션 이름 */
  allowedOptions: string[];
  /** --help --advanced에서만 보이는 줄 (i18n 키) */
  advancedKeys?: string[];
  run(ctx: Ctx): Promise<number>;
}
