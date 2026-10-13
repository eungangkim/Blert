import type { Alert, SoundKind } from '../shared/types.js';
import { getLanguage, t, type Language } from '../i18n/index.js';
import type { NotifyAdapter } from './adapters.js';
import { captureProcess, runProcess, type CaptureFn, type RunFn } from './proc.js';
import { sanitizeSpeech, speechText } from './speech.js';

/** 음성 알림 설정 (v1.3, D-112, D-116). 설정 파일의 `voice` 항목과 같다 */
export interface VoiceConfig {
  enabled: boolean;
  kinds: SoundKind[];
  voiceName?: string;
}

/** 기본으로 읽는 알림 종류 (D-112) */
export const DEFAULT_VOICE_KINDS: readonly SoundKind[] = ['warn', 'account'];
/** 재생을 기다리는 문장은 이만큼까지만 쌓고 오래된 것부터 버린다 (D-115) */
export const MAX_WAITING = 2;

export interface VoiceInfo {
  name: string;
  culture?: string;
}

/**
 * OS 내장 음성(TTS)으로 말하고 설치된 음성을 조회한다 (D-111). 문장과 음성 이름은 환경 변수로만 넘기고
 * 명령줄에는 고정 문자열만 쓴다(D-117). 클라우드 음성은 쓰지 않는다.
 *  - Windows: System.Speech (PowerShell)   — 한국어(Heami)·영어(Zira) 음성을 이 PC에서 확인함
 *  - macOS: say, Linux: spd-say 또는 espeak-ng — 사용자 리뷰로 판단한다 (D-89)
 */
export class VoiceEngine {
  private platform: NodeJS.Platform;
  private run: RunFn;
  private capture: CaptureFn;

  constructor(o: { platform?: NodeJS.Platform; run?: RunFn; capture?: CaptureFn } = {}) {
    this.platform = o.platform ?? process.platform;
    this.run = o.run ?? runProcess;
    this.capture = o.capture ?? captureProcess;
  }

  /** 문장을 소리 내어 읽고 끝나면 돌아온다. voiceName이 없으면 OS 기본 음성. 실패하면 Error */
  async speak(text: string, voiceName?: string): Promise<void> {
    const env = { BLERT_SPEECH: sanitizeSpeech(text), BLERT_VOICE: voiceName ?? '' };
    if (this.platform === 'win32') {
      return this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_SPEAK], env);
    }
    if (this.platform === 'darwin') return this.run('/bin/sh', ['-c', MAC_SPEAK], env);
    return this.run('/bin/sh', ['-c', LINUX_SPEAK], env);
  }

  /** 설치된 음성 목록. 조회할 수 없으면 Error */
  async list(): Promise<VoiceInfo[]> {
    if (this.platform === 'win32') {
      const out = await this.capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_LIST]);
      return parseLines(out, (l) => {
        const [name, culture] = l.split('|');
        return name ? { name: name.trim(), ...(culture ? { culture: culture.trim() } : {}) } : undefined;
      });
    }
    if (this.platform === 'darwin') {
      const out = await this.capture('say', ['-v', '?']);
      return parseLines(out, (l) => {
        const m = /^(.+?)\s{2,}([A-Za-z]{2,3}[_-][A-Za-z0-9]+)\s+#/.exec(l);
        return m ? { name: m[1]!.trim(), culture: m[2]!.replace('_', '-') } : undefined;
      });
    }
    const out = await this.capture('espeak-ng', ['--voices']);
    return parseLines(out.split('\n').slice(1).join('\n'), (l) => {
      const cols = l.trim().split(/\s+/);
      return cols.length >= 4 ? { name: cols[3]!, culture: cols[1]! } : undefined;
    });
  }
}

function parseLines(out: string, parse: (line: string) => VoiceInfo | undefined): VoiceInfo[] {
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(parse).filter((v): v is VoiceInfo => v !== undefined);
}

const WIN_SPEAK =
  "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; if ($env:BLERT_VOICE) { $s.SelectVoice($env:BLERT_VOICE) }; $s.Speak($env:BLERT_SPEECH)";
const WIN_LIST =
  "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }";
const MAC_SPEAK = 'exec say ${BLERT_VOICE:+-v "$BLERT_VOICE"} -- "$BLERT_SPEECH"';
const LINUX_SPEAK =
  'if command -v spd-say >/dev/null 2>&1; then exec spd-say -w ${BLERT_VOICE:+-y "$BLERT_VOICE"} -- "$BLERT_SPEECH"; else exec espeak-ng ${BLERT_VOICE:+-v "$BLERT_VOICE"} -- "$BLERT_SPEECH"; fi';

export interface VoiceAdapterOptions {
  /** list가 있으면, 사용자가 음성을 고르지 않았을 때 현재 언어에 맞는 설치 음성을 자동으로 고른다 (D-129) */
  engine: Pick<VoiceEngine, 'speak'> & Partial<Pick<VoiceEngine, 'list'>>;
  /** 현재 메시지 언어. 기본은 i18n의 현재 언어 */
  language?: () => Language;
  /** 재생할 때마다 설정을 읽는다 (D-117). 설정이 없으면 꺼진 것으로 본다 */
  config: () => Promise<VoiceConfig | undefined>;
  /** 선택한 음성이 없어 기본 음성으로 대신할 때의 안내 (한 번만) */
  warn?: (text: string) => void;
}

interface QueueItem {
  text: string;
  voiceName?: string;
  /** voiceName을 사용자가 고르지 않고 언어에 맞춰 자동으로 골랐는가 */
  auto?: boolean;
  resolve: () => void;
  reject: (e: unknown) => void;
}

/**
 * 알림을 음성으로 읽는다 (FR-NOTI-05). 읽을 종류만 읽고(D-112), 소리가 끝난 뒤에 한 번에 하나씩 말하며 대기가 쌓이면
 * 오래된 것을 버린다(D-114, D-115). 실패해도 알림과 소리는 정상이다(D-117).
 */
export class VoiceAdapter implements NotifyAdapter {
  readonly name = 'voice';
  /** 소리 어댑터가 끝난 뒤에 실행한다 (D-114) */
  readonly after = 'sound';
  private queue: QueueItem[] = [];
  private busy = false;
  private warnedMissing = false;
  /** 언어별로 자동 선택한 음성(없으면 undefined). 설치된 음성은 실행 중에 바뀌지 않는다고 보고 한 번만 조회한다 */
  private autoVoices = new Map<Language, Promise<string | undefined>>();

  constructor(private opts: VoiceAdapterOptions) {}

  async send(alerts: Alert[]): Promise<void> {
    const cfg = await this.opts.config();
    if (!cfg?.enabled) return;
    const alert = alerts.find((a) => a.sound !== 'off' && cfg.kinds.includes(a.sound ?? a.kind));
    if (!alert) return;
    const text = speechText(alert);
    if (!text) return;
    const auto = cfg.voiceName ? undefined : await this.autoVoice();
    const voiceName = cfg.voiceName ?? auto;
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ text, ...(voiceName ? { voiceName } : {}), ...(auto ? { auto: true } : {}), resolve, reject });
      while (this.queue.length > MAX_WAITING) this.queue.shift()!.resolve(); // 오래된 것은 버린다
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let item = this.queue.shift(); item; item = this.queue.shift()) {
        try {
          await this.say(item.text, item.voiceName, item.auto);
          item.resolve();
        } catch (e) {
          item.reject(e);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * 음성을 고르지 않은 사용자를 위해 현재 언어에 맞는 설치 음성을 고른다 (D-129). 한국어 PC의 기본 음성이 한국어일 때
   * 영어 문장을 어색하게 읽는 일을 막는다. 맞는 음성이 없거나 조회할 수 없으면 OS 기본 음성을 쓴다.
   */
  private autoVoice(): Promise<string | undefined> {
    const list = this.opts.engine.list?.bind(this.opts.engine);
    if (!list) return Promise.resolve(undefined);
    const language = this.opts.language?.() ?? getLanguage();
    let found = this.autoVoices.get(language);
    if (!found) {
      found = list()
        .then((voices) => voices.find((v) => v.culture?.toLowerCase().split(/[-_]/)[0] === language)?.name)
        .catch(() => undefined);
      this.autoVoices.set(language, found);
    }
    return found;
  }

  /** 선택한 음성으로 말하고, 실패하면 OS 기본 음성으로 한 번 더 시도한다. 기본 음성으로 되면 안내를 한 번만 한다 (D-117) */
  private async say(text: string, voiceName?: string, auto?: boolean): Promise<void> {
    try {
      await this.opts.engine.speak(text, voiceName);
    } catch (e) {
      if (!voiceName) throw e;
      await this.opts.engine.speak(text); // 이것도 실패하면 그대로 던진다
      if (!auto && !this.warnedMissing) {
        this.warnedMissing = true;
        this.opts.warn?.(t('notify.voiceMissing', { name: voiceName }));
      }
    }
  }
}
