import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { ServicePort } from './cli/index.js';
import { TASK_NAME } from './cli/service.js';

/**
 * Windows 작업 스케줄러로 로그인 시 자동 시작을 등록하는 구현 (D-64, v0.5). 진입점이 cli의 ServicePort에 연결한다.
 * 관리자 권한 없이 `schtasks /Create /XML`로 현재 사용자의 로그온 작업을 만든다 (2026-10-06 이 PC에서 확인).
 * 문서: https://learn.microsoft.com/windows-server/administration/windows-commands/schtasks-create
 * schtasks의 출력은 시스템 언어(코드 페이지)로 나와 문구를 해석하지 않고 종료 코드만 쓴다.
 */
function schtasks(args: string[]): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve) => {
    execFile('schtasks', args, { encoding: 'buffer', windowsHide: true, timeout: 30_000 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? '')) });
    });
  });
}

/** schtasks가 XML을 UTF-16(BOM 있음) 또는 UTF-8로 내보내는 경우를 모두 처리한다 */
function decode(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

const unescapeXml = (s: string): string => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function createServicePort(taskName: string = TASK_NAME): ServicePort {
  const supported = process.platform === 'win32';
  return {
    supported,
    nodePath: process.execPath,
    scriptPath: process.argv[1] ?? '',
    fileExists: (p) => existsSync(p),
    currentUser: async () => {
      const name = userInfo().username;
      return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
    },
    async register(xml) {
      const dir = mkdtempSync(join(tmpdir(), 'blert-task-'));
      const file = join(dir, 'task.xml');
      try {
        // 작업 스케줄러는 UTF-16 LE(BOM 포함) XML을 받는다
        writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
        const r = await schtasks(['/Create', '/TN', taskName, '/XML', file, '/F']);
        return r.code === 0 ? { ok: true } : { ok: false, detail: `schtasks ${r.code}` };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async unregister() {
      const exists = (await schtasks(['/Query', '/TN', taskName])).code === 0;
      if (!exists) return { ok: true, existed: false };
      const r = await schtasks(['/Delete', '/TN', taskName, '/F']);
      return r.code === 0 ? { ok: true, existed: true } : { ok: false, detail: `schtasks ${r.code}` };
    },
    async query() {
      const r = await schtasks(['/Query', '/TN', taskName, '/XML']);
      if (r.code !== 0) return undefined;
      const xml = decode(r.stdout);
      const command = /<Command>([\s\S]*?)<\/Command>/.exec(xml)?.[1];
      if (command === undefined) return undefined;
      return { command: unescapeXml(command.trim()), args: unescapeXml(/<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml)?.[1]?.trim() ?? '') };
    },
  };
}
