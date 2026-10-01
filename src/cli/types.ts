import type { Store } from '../store/index.js';
import type { PresetService } from '../presets/index.js';
import type { SoundKind } from '../shared/types.js';
import type { KeyService } from '../security/index.js';
import type { NetworkMode } from '../shared/network.js';

export type { PresetService };

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** 질문을 출력하고 한 줄을 받는다. 입력이 끝났으면 null. */
  ask(question: string): Promise<string | null>;
}

/**
 * 시험 알림·소리 시험에 필요한 기능. cli는 notify를 직접 알 수 없어(B2) cli가 정의하고,
 * 실제 구현(notify의 Notifier)은 진입점에서 연결한다.
 */
export interface NotifierPort {
  /** 시험 알림을 데스크톱·콘솔·소리로 보낸다. 소리는 설정(켬/끔)을 따른다 */
  test(kind: SoundKind): Promise<void>;
  /** 설정과 무관하게 소리만 재생한다. 실패하면 Error */
  soundTest(kind: SoundKind): Promise<void>;
}

/** `blert run`이 부르는 감시 실행기. runtime이 구현하고 진입점에서 연결한다 (B2). 종료 코드를 돌려준다. */
export interface Runner {
  run(opts: { verbose: boolean }): Promise<number>;
}

export interface Deps {
  store: Store;
  presets: PresetService;
  notifier: NotifierPort;
  runner: Runner;
  /** 키 등록·삭제·확인 (security가 구현, v0.2) */
  keys: KeyService;
  /** 개발자 전용 BLERT_NETWORK=testnet 이면 testnet */
  network: NetworkMode;
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
