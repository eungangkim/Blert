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
  /** 데몬 안에서 도는 감시 (숨김 명령 daemon-run, v0.4) */
  daemon(opts: { verbose: boolean; service: boolean }): Promise<number>;
}

/**
 * 데몬 프로세스를 띄우고 끄는 기능과 대기에 쓰는 시계 (v0.4). cli는 child_process를 직접 쓰지 않고
 * 진입점에서 연결한 구현을 쓴다. 테스트는 가짜 시계와 가짜 프로세스를 넣는다.
 */
export interface DaemonPort {
  /** 같은 실행 파일을 숨김 명령으로 분리 실행한다. exit는 자식이 끝나면 종료 코드로 이행한다 (분리한 뒤에는 의미 없음) */
  launch(opts?: { service?: boolean }): { pid: number; exit: Promise<number>; detach(): void };
  /** 프로세스를 강제 종료한다 */
  kill(pid: number): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * OS 서비스(로그인 시 자동 시작) 등록 기능 (v0.5, D-62~D-66). cli는 child_process를 직접 쓰지 않고
 * 진입점에서 연결한 구현을 쓴다. 테스트는 가짜를 넣는다.
 */
export interface ServicePort {
  /** 이 OS에서 등록을 지원하는가. v0.5는 Windows만 (D-63) */
  supported: boolean;
  /** 지금 실행 중인 node 실행 파일과 index.js의 절대 경로 (D-65) */
  nodePath: string;
  scriptPath: string;
  fileExists(path: string): boolean;
  /** 작업 소유자 (예: DOMAIN\user) */
  currentUser(): Promise<string>;
  /** 작업을 만들거나 같은 이름으로 덮어쓴다 */
  register(xml: string): Promise<{ ok: true } | { ok: false; detail: string }>;
  /** 작업을 지운다. existed는 원래 있었는지 */
  unregister(): Promise<{ ok: true; existed: boolean } | { ok: false; detail: string }>;
  /** 등록된 작업의 실행 명령과 인자. 없으면 undefined */
  query(): Promise<{ command: string; args: string } | undefined>;
}

/**
 * 외부 알림 채널(텔레그램) 등록에 필요한 기능 (v1.0, D-69~D-73). cli는 notify를 직접 알 수 없어 cli가 정의하고
 * 진입점에서 연결한다. 토큰은 키체인에만 두고 이 포트를 통해서만 다룬다.
 */
export interface ChannelPort {
  /** 이 환경에서 OS 키체인을 쓸 수 있는가 (D-30) */
  keychainAvailable(): Promise<boolean>;
  /** 봇이 받은 메시지에서 대화를 찾는다 (오래된 것부터) */
  listChats(token: string): Promise<{ ok: true; chats: { chatId: string; name: string }[] } | { ok: false; reason: 'rejected' | 'network' | 'http' }>;
  /** 메시지를 보낸다. token을 생략하면 키체인에 저장된 토큰을 쓴다 */
  send(chatId: string, text: string, token?: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  saveToken(token: string): Promise<void>;
  removeToken(): Promise<boolean>;
  hasToken(): Promise<boolean>;
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
  /** 데몬 시작·종료·대기 (v0.4) */
  daemon: DaemonPort;
  /** 로그인 시 자동 시작 등록 (v0.5) */
  service: ServicePort;
  /** 외부 알림 채널 (v1.0) */
  channel: ChannelPort;
  /** 호출하면 Ctrl+C에 중단되는 신호를 돌려준다 (blert logs -f). 호출한 때부터 Ctrl+C를 가로챈다 */
  interrupt: () => AbortSignal;
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
  /** true면 도움말·오타 제안에 나오지 않는 내부 명령 */
  hidden?: boolean;
  /** 도움말의 사용법 줄 (i18n 키) */
  usageKeys: string[];
  /** 이 명령이 받는 옵션 이름 */
  allowedOptions: string[];
  /** --help --advanced에서만 보이는 줄 (i18n 키) */
  advancedKeys?: string[];
  run(ctx: Ctx): Promise<number>;
}
