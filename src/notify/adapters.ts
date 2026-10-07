import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Alert, SoundKind } from '../shared/types.js';
import { runProcess, type RunFn } from './proc.js';
import { clockHMS, render } from './render.js';

/** 출력 채널 어댑터 (B7). 새 채널(텔레그램 등)은 이 인터페이스를 구현해 추가한다 (FR-NOTI-03). */
/** 어댑터에 알림을 넘길 때의 부가 정보 */
export interface SendContext {
  /** 데스크톱에는 묶음 요약 1건이 나가는 상황인가 (D-28). wantsAll 어댑터가 자기 기준으로 다시 묶을 때 쓴다 */
  summarized: boolean;
}

export interface NotifyAdapter {
  name: string;
  /** true면 묶음 요약 대신 개별 알림 전체를 받는다 (요약 시에도 전체는 콘솔에 남긴다, D-28) */
  wantsAll?: boolean;
  send(alerts: Alert[], ctx?: SendContext): Promise<void>;
}

const ICON: Record<SoundKind, string> = { up: '▲', down: '▼', account: '●', warn: '!' };

/** 포그라운드 실행 시 터미널 출력 */
export class ConsoleAdapter implements NotifyAdapter {
  readonly name = 'console';
  readonly wantsAll = true;
  constructor(
    private out: (line: string) => void,
    private now: () => number = Date.now,
  ) {}

  async send(alerts: Alert[]): Promise<void> {
    for (const a of alerts) {
      const { title, body } = render(a);
      this.out(`${clockHMS(this.now())} ${ICON[a.kind]} ${title}${body ? ` — ${body}` : ''}`);
    }
  }
}

// Windows 알림: .NET NotifyIcon 풍선 알림을 -Command로 실행한다 (Windows 10·11은 이를 토스트로 표시).
// 제목·본문은 환경변수로만 받아 스크립트에 값이 섞이지 않는다(고정 문자열).
//
// -EncodedCommand와 WinRT(ToastNotificationManager)를 쓰는 방식은 쓰지 않는다: 실측에서 Avast가 활성인 PC는
// 그런 PowerShell을 띄운 프로세스(감시 본체 포함)를 소리 없이 종료시켰다. 이 방식은 같은 PC에서 생존을 확인했다.
// 풍선 제한: 제목 63자, 본문 255자.
export const WIN_NOTIFY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$n = New-Object System.Windows.Forms.NotifyIcon',
  '$n.Icon = [System.Drawing.SystemIcons]::Information',
  '$n.Visible = $true',
  '$title = [string]$env:BLERT_TITLE',
  '$body = [string]$env:BLERT_BODY',
  'if ($title.Length -gt 63) { $title = $title.Substring(0, 63) }',
  'if ($body.Length -gt 255) { $body = $body.Substring(0, 255) }',
  '$n.ShowBalloonTip(5000, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info)',
  'Start-Sleep -Milliseconds 2000',
  '$n.Dispose()',
].join('\n');

/**
 * OS 기본 알림 (FR-NOTI-01). macOS osascript, Windows PowerShell(NotifyIcon 풍선), Linux notify-send.
 * 소리는 blert가 직접 재생한다.
 */
export class DesktopAdapter implements NotifyAdapter {
  readonly name = 'desktop';
  constructor(
    private platform: NodeJS.Platform = process.platform,
    private run: RunFn = runProcess,
  ) {}

  /** 알림은 서로 기다리지 않고 동시에 띄운다 (프로세스 시작에 0.3초 안팎이 걸려 순서대로 하면 늦어진다) */
  async send(alerts: Alert[]): Promise<void> {
    await Promise.all(
      alerts.map(async (a) => {
        const { title, body } = render(a);
        try {
          await this.toast(title, body);
        } catch {
          await this.toast(title, body); // 프로세스 생성이 가끔 일시적으로 실패한다(실측). 한 번만 다시 시도한다.
        }
      }),
    );
  }

  private toast(title: string, body: string): Promise<void> {
    if (this.platform === 'win32') {
      return this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_NOTIFY_SCRIPT], {
        BLERT_TITLE: title,
        BLERT_BODY: body,
      });
    }
    if (this.platform === 'darwin') {
      return this.run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', '--', title, body]);
    }
    return this.run('notify-send', ['--app-name=blert', '--', title, body]);
  }
}

/** 묶음에서 실제로 재생할 소리. 첫 번째로 무음이 아닌 알림을 따른다. 전부 무음이면 undefined. */
export function pickSound(alerts: Alert[]): SoundKind | undefined {
  for (const a of alerts) {
    if (a.sound === 'off') continue;
    return a.sound ?? a.kind;
  }
  return undefined;
}

export const DEFAULT_SOUND_DIR = fileURLToPath(new URL('../../assets/sounds/', import.meta.url));

export interface SoundOptions {
  /** 소리 켬 여부. 알림을 보낼 때마다 확인한다 (blert sound off가 바로 반영되게) */
  enabled: () => boolean | Promise<boolean>;
  dir?: string;
  platform?: NodeJS.Platform;
  run?: RunFn;
}

/** 알림 유형별 WAV 재생 (FR-NOTI-02). 추가 의존성 없이 OS 기본 재생 도구를 쓴다 (B7). */
export class SoundAdapter implements NotifyAdapter {
  readonly name = 'sound';
  private dir: string;
  private platform: NodeJS.Platform;
  private run: RunFn;

  constructor(private opts: SoundOptions) {
    this.dir = opts.dir ?? DEFAULT_SOUND_DIR;
    this.platform = opts.platform ?? process.platform;
    this.run = opts.run ?? runProcess;
  }

  async send(alerts: Alert[]): Promise<void> {
    if (!(await this.opts.enabled())) return;
    const kind = pickSound(alerts);
    if (kind) await this.play(kind);
  }

  /** 설정과 무관하게 재생한다 (`blert sound test`). 실패하면 Error. */
  async play(kind: SoundKind): Promise<void> {
    const file = join(this.dir, `${kind}.wav`);
    if (this.platform === 'win32') {
      return this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object System.Media.SoundPlayer $env:BLERT_SOUND).PlaySync()'], { BLERT_SOUND: file });
    }
    if (this.platform === 'darwin') return this.run('afplay', [file]);
    try {
      await this.run('paplay', [file]);
    } catch {
      await this.run('aplay', ['-q', file]); // paplay가 없으면 aplay
    }
  }
}
