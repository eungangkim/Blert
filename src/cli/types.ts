import type { Store } from '../store/index.js';

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** 질문을 출력하고 한 줄을 받는다. 입력이 끝났으면 null. */
  ask(question: string): Promise<string | null>;
}

/** presets 모듈이 채우는 인터페이스 (4단계). cli는 구현을 모른다. */
export interface PresetService {
  list(): { slug: string; nameKey: string }[];
  /** 설치하고 등록된 규칙 수를 돌려준다 */
  install(slug: string): Promise<number>;
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
