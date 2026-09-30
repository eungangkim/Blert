import { spawn } from 'node:child_process';

/** 외부 명령 실행. 실패(없는 명령, 0이 아닌 종료 코드, 시간 초과)는 Error로 알린다. */
export type RunFn = (cmd: string, args: string[], env?: Record<string, string>) => Promise<void>;

const TIMEOUT_MS = 15_000;

/**
 * 셸을 거치지 않고 인자 배열로 실행한다. 알림 제목·본문 같은 값은 인자나 환경변수로만 넘겨
 * 명령 주입이 생기지 않게 한다.
 */
export const runProcess: RunFn = (cmd, args, env) =>
  new Promise<void>((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} timed out`));
    }, TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
