export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
const order: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

// 키 형태 문자열 마스킹 (NFR-SEC-01): PEM 블록, 32자 이상 영숫자·base64 덩어리.
const PEM = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g;
const LONG_TOKEN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

export function mask(text: string): string {
  return text.replace(PEM, '***').replace(LONG_TOKEN, '***');
}

export interface LogSink {
  write(line: string): void;
}

/** 한 줄에 한 이벤트: 시각·레벨·모듈·메시지 (B10). */
export class Logger {
  constructor(
    private sink: LogSink,
    private level: LogLevel = 'info',
    private now: () => number = Date.now,
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  log(level: LogLevel, module: string, message: string): void {
    if (order[level] > order[this.level]) return;
    const line = `${new Date(this.now()).toISOString()} ${level} ${module} ${message}`;
    this.sink.write(mask(line).replace(/\r?\n/g, ' '));
  }

  error(m: string, msg: string) { this.log('error', m, msg); }
  warn(m: string, msg: string) { this.log('warn', m, msg); }
  info(m: string, msg: string) { this.log('info', m, msg); }
  debug(m: string, msg: string) { this.log('debug', m, msg); }
}
