import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Alert, SoundKind } from '../shared/types.js';
import { runProcess, type RunFn } from './proc.js';
import { clockHMS, render } from './render.js';

/** 출력 채널 어댑터 (B7). 새 채널(텔레그램 등)은 이 인터페이스를 구현해 추가한다 (FR-NOTI-03). */
export interface NotifyAdapter {
  name: string;
  /** true면 묶음 요약 대신 개별 알림 전체를 받는다 (요약 시에도 전체는 콘솔에 남긴다, D-28) */
  wantsAll?: boolean;
  send(alerts: Alert[]): Promise<void>;
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

// Windows 토스트. 제목·본문은 환경변수로 받아 스크립트에 값이 섞이지 않는다.
// 앱 ID는 Windows PowerShell에 등록된 것을 빌린다(별도 앱 등록 없이 토스트를 띄우기 위함).
const WIN_TOAST = `
$ErrorActionPreference = 'Stop'
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$title = [System.Security.SecurityElement]::Escape($env:BLERT_TITLE)
$body = [System.Security.SecurityElement]::Escape($env:BLERT_BODY)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual><audio silent='true'/></toast>")
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
`;
export const WIN_TOAST_ENCODED = Buffer.from(WIN_TOAST, 'utf16le').toString('base64');

/**
 * OS 기본 알림 (FR-NOTI-01). macOS osascript, Windows PowerShell 토스트, Linux notify-send.
 * 소리는 blert가 직접 재생하므로 토스트 자체는 무음이다.
 */
export class DesktopAdapter implements NotifyAdapter {
  readonly name = 'desktop';
  constructor(
    private platform: NodeJS.Platform = process.platform,
    private run: RunFn = runProcess,
  ) {}

  async send(alerts: Alert[]): Promise<void> {
    for (const a of alerts) {
      const { title, body } = render(a);
      try {
        await this.toast(title, body);
      } catch {
        await this.toast(title, body); // 프로세스 생성이 가끔 일시적으로 실패한다(실측). 한 번만 다시 시도한다.
      }
    }
  }

  private toast(title: string, body: string): Promise<void> {
    if (this.platform === 'win32') {
      return this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', WIN_TOAST_ENCODED], {
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
