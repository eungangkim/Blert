import type { EventBus } from '../shared/bus.js';
import type { Alert, SoundKind } from '../shared/types.js';
import { toHistoryEntry, type HistoryEntry, type QuietMark } from '../shared/history.js';
import { isMuted, type QuietScope } from '../shared/quiet.js';
import type { Clock } from '../shared/clock.js';
import { iso, systemClock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import { platformGroup } from '../shared/platform.js';
import { t } from '../i18n/index.js';
import { ConsoleAdapter, DesktopAdapter, SoundAdapter, type NotifyAdapter } from './adapters.js';
import { TelegramAdapter, TelegramClient, type ChannelSource, type TelegramClientOptions } from './telegram.js';
import type { RunFn } from './proc.js';
import { VoiceAdapter, type VoiceAdapterOptions } from './voice.js';
import { gapTimes, render, summarizeAlerts } from './render.js';

export type { NotifyAdapter, SendContext } from './adapters.js';
export { VoiceEngine, VoiceAdapter, DEFAULT_VOICE_KINDS, MAX_WAITING, type VoiceConfig, type VoiceInfo } from './voice.js';
export { speechText, sanitizeSpeech, SPEECH_MAX_CHARS } from './speech.js';
export { TelegramClient, TelegramAdapter, classifyAlert, formatMessage, TELEGRAM_HOSTS, type ChannelSource, type TgResult } from './telegram.js';

const LOG = 'notify';
/**
 * 폭주 묶음(D-28)을 위해 알림을 잠깐 모아 두는 시간. NFR-PERF-01(1초 이내)을 지키려고 짧게 잡았다:
 * Windows 토스트 표시에 0.3~0.5초가 걸려(실측) 합치면 1초 안쪽이 된다.
 * 이 안에 3건 이상 모이면 요약 1건으로 보낸다.
 */
export const HOLD_MS = 300;
/** B7: 10초 창 안에 여러 건이 발동하면 묶는다 */
export const WINDOW_MS = 10_000;
/**
 * 감시 중단 구간 알림을 합치는 시간. 같은 끊김이 공개 스트림(현물·선물)과 계정 연결에서 각각 보고되므로,
 * 이 시간 안에 들어온 구간은 가장 이른 시작부터 가장 늦은 끝까지의 알림 한 건으로 보낸다 (NFR-REL-02).
 * 연결마다 복구 시각이 수백 ms씩 달라서 한 번의 끊김에 같은 경고가 3번, 소리도 겹쳐 3번 나던 문제를 막는다.
 */
export const GAP_MERGE_MS = 1_500;
const SUMMARY_MIN = 3;

export interface NotifierOptions {
  adapters: NotifyAdapter[];
  /** `blert sound test`용. 없으면 소리 시험은 불가 */
  sound?: SoundAdapter;
  /** 한 번만 보여주는 안내(알림·소리 실패 원인과 해결 방법)를 사용자에게 출력한다 */
  warn: (text: string) => void;
  clock?: Clock;
  logger?: Logger;
  platform?: NodeJS.Platform;
  holdMs?: number;
  windowMs?: number;
  gapMergeMs?: number;
  /**
   * 지금 조용히 해야 하는지와 범위 (v1.5, D-135~D-141). 알림을 보낼 때마다 부르므로 설정 변경이 바로 반영된다.
   * `notify`는 `store`를 모르므로 `src/index.ts`에서 주입한다 (B2). 조용한 시간이 아니면 undefined
   */
  quiet?: () => Promise<QuietScope | undefined> | QuietScope | undefined;
  /** 발동한 알림을 기록한다 (v1.5, D-142). 감시 시작·복구 공지와 `blert test`는 부르지 않는다. 실패해도 알림은 계속된다 */
  record?: (entries: HistoryEntry[]) => void;
}

/** 조용한 시간에 소리·음성만 끄는 어댑터 (D-136). 그 밖의 화면·채널 어댑터는 `--all`일 때만 끈다. console은 끄지 않는다 */
const SOUND_ADAPTERS: ReadonlySet<string> = new Set(['sound', 'voice']);
const ALWAYS_ON_ADAPTERS: ReadonlySet<string> = new Set(['console']);

/** 보내는 방식: 기록할지, 조용한 시간을 따를지 */
interface DeliverOptions {
  record: boolean;
  quiet: boolean;
}

/**
 * 발동된 알림을 채널 어댑터로 내보낸다 (B7).
 * - warn 종류는 묶지 않고 즉시 개별 전송한다.
 * - 그 외는 잠깐 모아, 3건 이상이면 "알림 N건" 요약 1건(소리도 1회)으로 보낸다. 전체는 콘솔과 로그에 남긴다.
 * - 어댑터 하나가 실패해도 다른 어댑터는 계속 동작하고, 실패 안내는 어댑터별로 한 번만 보여준다.
 */
export class Notifier {
  private pending: Alert[] = [];
  private delivered: number[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private inflight = new Set<Promise<unknown>>();
  private warned = new Set<string>();
  private status = new Map<string, { state: string; attempt: number }>();
  private clock: Clock;
  private holdMs: number;
  private windowMs: number;
  private gapMergeMs: number;
  /** 합치는 중인 감시 중단 구간. 끝난 구간과 아직 이어지는 구간(ongoing)을 따로 모은다 */
  private gaps = new Map<boolean, { from: number; to: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(private opts: NotifierOptions) {
    this.clock = opts.clock ?? systemClock;
    this.holdMs = opts.holdMs ?? HOLD_MS;
    this.windowMs = opts.windowMs ?? WINDOW_MS;
    this.gapMergeMs = opts.gapMergeMs ?? GAP_MERGE_MS;
  }

  /** 버스에서 발동 알림과 연결 끊김·감시 중단을 받아 내보낸다. 반환값은 연결 해제 함수. */
  attach(bus: EventBus): () => void {
    const offs = [
      bus.on('rule.fired', (e) => this.notify(e.alert)),
      bus.on('conn.status', (e) => void this.status.set(e.stream, { state: e.state, attempt: e.attempt })),
      bus.on('conn.gap', (e) => this.mergeGap(e)),
      bus.on('key.denied', (e) => this.notify(this.keyAlert(e))),
    ];
    return () => offs.forEach((off) => off());
  }

  notify(alert: Alert): void {
    if (alert.kind === 'warn') {
      this.track(this.deliver([alert], [alert], { record: true, quiet: true }));
      return;
    }
    this.pending.push(alert);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.track(this.release());
    }, this.holdMs);
  }

  /** 감시 시작 같은 공지: 묶음 없이 바로 보낸다 */
  announce(alert: Alert): void {
    this.track(this.deliver([alert], [alert], { record: false, quiet: true }));
  }

  /** `blert test`: 묶음 없이 바로 보낸다. 소리는 설정(켬/끔)을 따른다. */
  async test(kind: SoundKind): Promise<void> {
    const alert: Alert = { ruleId: 0, kind, titleKey: 'alert.test.title', params: { kind }, firedAt: iso(this.clock.now()) };
    await this.deliver([alert], [alert], { record: false, quiet: false }); // 시험은 조용한 시간에도 확인할 수 있어야 한다
  }

  /** `blert sound test`: 설정과 무관하게 소리만 재생한다. 재생에 실패하면 Error. */
  async soundTest(kind: SoundKind): Promise<void> {
    if (!this.opts.sound) throw new Error('sound adapter is not available');
    await this.opts.sound.play(kind);
  }

  /** 모아 둔 알림을 지금 보내고 진행 중인 전송이 끝나기를 기다린다 (종료·테스트용) */
  async flush(): Promise<void> {
    for (const ongoing of [...this.gaps.keys()]) this.releaseGap(ongoing);
    clearTimeout(this.timer);
    this.timer = undefined;
    this.track(this.release());
    await Promise.allSettled([...this.inflight]);
  }

  // ---- 내부 ----

  private release(): Promise<void> {
    const batch = this.pending.splice(0);
    if (batch.length === 0) return Promise.resolve();
    const now = this.clock.now();
    this.delivered = this.delivered.filter((ts) => now - ts <= this.windowMs);
    // 이번에 모인 게 3건 이상이거나, 10초 창의 누적이 3건 이상이면서 이번에 2건 이상이면 묶는다
    const summarize = batch.length >= SUMMARY_MIN || (batch.length >= 2 && this.delivered.length + batch.length >= SUMMARY_MIN);
    this.delivered.push(...batch.map(() => now));
    return this.deliver(summarize ? [this.summary(batch)] : batch, batch, { record: true, quiet: true });
  }

  private summary(batch: Alert[]): Alert {
    return summarizeAlerts(batch);
  }

  private async deliver(display: Alert[], full: Alert[], o: DeliverOptions): Promise<void> {
    for (const a of full) {
      const { title, body } = render(a);
      this.opts.logger?.info(LOG, `${a.kind} ${title}${body ? ` | ${body}` : ''}`);
    }
    const scope = o.quiet ? await this.quietScope() : undefined;
    if (o.record) this.record(full, scope);
    // 어댑터는 동시에 보내되, after를 지정한 어댑터(음성)는 그 어댑터(소리)가 끝난 뒤에 보낸다 (D-114)
    const finished = new Map<string, Promise<void>>();
    await Promise.allSettled(
      this.opts.adapters.map((adapter) => {
        const wait = adapter.after ? finished.get(adapter.after) : undefined;
        const p = (async () => {
          await wait;
          try {
            const source = adapter.wantsAll ? full : display;
            const list = quietFor(adapter.name, scope) ? source.filter((a) => !isMuted(scope, a.kind)) : source;
            if (list.length === 0) return; // 조용한 시간이라 보낼 것이 없다
            await adapter.send(list, { summarized: display.length === 1 && display[0]!.titleKey === 'alert.batch.title' });
          } catch (e) {
            this.reportFailure(adapter.name, e);
          }
        })();
        finished.set(adapter.name, p);
        return p;
      }),
    );
  }

  /** 지금의 조용한 시간 범위. 판정이 실패하면 조용하지 않은 것으로 본다(알림을 놓치는 쪽이 더 위험하다) */
  private async quietScope(): Promise<QuietScope | undefined> {
    try {
      return await this.opts.quiet?.();
    } catch (e) {
      this.opts.logger?.warn(LOG, `quiet check failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  /** 기록 실패는 알림에 영향을 주지 않는다. 조용히 처리된 알림에는 표시를 붙인다 (D-142) */
  private record(full: Alert[], scope: QuietScope | undefined): void {
    if (!this.opts.record || full.length === 0) return;
    try {
      this.opts.record(full.map((a) => toHistoryEntry(a, isMuted(scope, a.kind) ? markOf(scope) : undefined)));
    } catch (e) {
      this.opts.logger?.warn(LOG, `history record failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 출력 실패: 알림 본문은 콘솔이 이미 보여주므로, 원인과 해결 방법만 어댑터별로 한 번 안내한다 (B7) */
  private reportFailure(name: string, e: unknown): void {
    const reason = e instanceof Error ? e.message : String(e);
    this.opts.logger?.warn(LOG, `${name} adapter failed: ${reason}`);
    if (this.warned.has(name) || (name !== 'desktop' && name !== 'sound' && name !== 'voice' && name !== 'telegram')) return;
    this.warned.add(name);
    if (name === 'telegram') return this.opts.warn(t('notify.telegramFailed', { reason })); // 토큰이 들어갈 수 있는 값은 reason에 넣지 않는다
    const guide = t(`notify.guide.${name}.${platformGroup(this.opts.platform)}`);
    this.opts.warn(t(`notify.${name}Failed`, { reason, guide }));
  }

  /** 키 때문에 계정 기능을 쓸 수 없을 때. 공개 알림은 계속된다는 것까지 알린다 (FR-KEY-02, FR-KEY-04, D-30) */
  private keyAlert(e: { reason: string; fields?: string[]; ts: string }): Alert {
    return { ruleId: 0, kind: 'warn', titleKey: `alert.key.${e.reason}.title`, params: { fields: (e.fields ?? []).join(', ') }, firedAt: e.ts };
  }

  /** 같은 끊김을 여러 연결이 따로 보고하므로, 짧은 시간 안의 중단 구간은 하나로 합친다 */
  private mergeGap(e: { from: string; to: string; ongoing?: boolean }): void {
    const key = e.ongoing === true;
    const from = Date.parse(e.from);
    const to = Date.parse(e.to);
    const current = this.gaps.get(key);
    if (current) {
      current.from = Math.min(current.from, from);
      current.to = Math.max(current.to, to);
      return;
    }
    const timer = setTimeout(() => this.releaseGap(key), this.gapMergeMs);
    timer.unref?.();
    this.gaps.set(key, { from, to, timer });
  }

  private releaseGap(ongoing: boolean): void {
    const g = this.gaps.get(ongoing);
    if (!g) return;
    clearTimeout(g.timer);
    this.gaps.delete(ongoing);
    this.notify(this.gapAlert({ from: iso(g.from), to: iso(g.to), ongoing }));
  }

  private gapAlert(e: { from: string; to: string; ongoing?: boolean }): Alert {
    const from = Date.parse(e.from);
    const to = Date.parse(e.to);
    if (e.ongoing) {
      const attempt = Math.max(0, ...[...this.status.values()].filter((s) => s.state !== 'open').map((s) => s.attempt));
      const minutes = Math.max(1, Math.round((to - from) / 60_000));
      return { ruleId: 0, kind: 'warn', titleKey: 'alert.conn.down.title', params: { minutes, attempt }, firedAt: e.to };
    }
    return { ruleId: 0, kind: 'warn', titleKey: 'alert.gap.title', params: gapTimes(from, to), firedAt: e.to };
  }

  private track(p: Promise<unknown>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }
}

/** 이 어댑터가 조용한 시간을 따라야 하는가. 소리·음성은 조용한 시간이면 항상, 화면·채널은 `--all`일 때만 (D-136) */
function quietFor(adapter: string, scope: QuietScope | undefined): boolean {
  if (!scope || ALWAYS_ON_ADAPTERS.has(adapter)) return false;
  return SOUND_ADAPTERS.has(adapter) || scope.all;
}

const markOf = (scope: QuietScope | undefined): QuietMark => (scope?.all ? 'all' : 'sound');

export interface CreateNotifierOptions {
  /** 콘솔 어댑터 출력과 실패 안내가 나갈 곳 */
  out: (line: string) => void;
  soundEnabled: () => boolean | Promise<boolean>;
  /** false면 콘솔 어댑터를 끈다 (데몬 모드) */
  console?: boolean;
  clock?: Clock;
  logger?: Logger;
  platform?: NodeJS.Platform;
  run?: RunFn;
  soundDir?: string;
  /** 사용자가 등록한 소리 파일 경로를 재생할 때마다 알려 준다 (v1.1, D-82·D-95). 없으면 번들 소리만 쓴다 */
  userSound?: (kind: SoundKind) => Promise<string | undefined>;
  /** 외부 알림 채널 (v1.0). 없으면 어댑터를 만들지 않는다. 등록 여부는 보내는 순간 확인한다 (D-69) */
  channel?: { source: ChannelSource; client?: TelegramClientOptions };
  /** 음성 알림 (v1.3). 없으면 어댑터를 만들지 않는다. 설정은 보내는 순간 읽는다 (D-117) */
  voice?: { engine: VoiceAdapterOptions['engine']; config: VoiceAdapterOptions['config'] };
  /** 조용한 시간 판정과 알림 기록 (v1.5). 없으면 항상 울리고 기록하지 않는다 */
  quiet?: NotifierOptions['quiet'];
  record?: NotifierOptions['record'];
}

/** 기본 어댑터(콘솔·데스크톱·소리)로 Notifier를 만든다 */
export function createNotifier(o: CreateNotifierOptions): Notifier {
  const clock = o.clock ?? systemClock;
  const sound = new SoundAdapter({ enabled: o.soundEnabled, dir: o.soundDir, platform: o.platform, run: o.run, userSound: o.userSound, warn: o.out });
  const adapters: NotifyAdapter[] = [
    ...(o.console === false ? [] : [new ConsoleAdapter(o.out, () => clock.now())]),
    new DesktopAdapter(o.platform, o.run),
    sound,
    ...(o.voice ? [new VoiceAdapter({ engine: o.voice.engine, config: o.voice.config, warn: o.out })] : []),
    ...(o.channel ? [new TelegramAdapter(o.channel.source, new TelegramClient({ logger: o.logger, ...o.channel.client }))] : []),
  ];
  return new Notifier({ adapters, sound, warn: o.out, clock, logger: o.logger, platform: o.platform, quiet: o.quiet, record: o.record });
}
