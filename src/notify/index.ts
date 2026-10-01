import type { EventBus } from '../shared/bus.js';
import type { Alert, SoundKind } from '../shared/types.js';
import type { Clock } from '../shared/clock.js';
import { iso, systemClock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import { platformGroup } from '../shared/platform.js';
import { t } from '../i18n/index.js';
import { ConsoleAdapter, DesktopAdapter, SoundAdapter, type NotifyAdapter } from './adapters.js';
import type { RunFn } from './proc.js';
import { gapTimes, render } from './render.js';

export type { NotifyAdapter } from './adapters.js';

const LOG = 'notify';
/**
 * 폭주 묶음(D-28)을 위해 알림을 잠깐 모아 두는 시간. NFR-PERF-01(1초 이내)을 지키려고 짧게 잡았다:
 * Windows 토스트 표시에 0.3~0.5초가 걸려(실측) 합치면 1초 안쪽이 된다.
 * 이 안에 3건 이상 모이면 요약 1건으로 보낸다.
 */
export const HOLD_MS = 300;
/** B7: 10초 창 안에 여러 건이 발동하면 묶는다 */
export const WINDOW_MS = 10_000;
const SUMMARY_MIN = 3;
const SUMMARY_TOP = 3;

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

  constructor(private opts: NotifierOptions) {
    this.clock = opts.clock ?? systemClock;
    this.holdMs = opts.holdMs ?? HOLD_MS;
    this.windowMs = opts.windowMs ?? WINDOW_MS;
  }

  /** 버스에서 발동 알림과 연결 끊김·감시 중단을 받아 내보낸다. 반환값은 연결 해제 함수. */
  attach(bus: EventBus): () => void {
    const offs = [
      bus.on('rule.fired', (e) => this.notify(e.alert)),
      bus.on('conn.status', (e) => void this.status.set(e.stream, { state: e.state, attempt: e.attempt })),
      bus.on('conn.gap', (e) => this.notify(this.gapAlert(e))),
    ];
    return () => offs.forEach((off) => off());
  }

  notify(alert: Alert): void {
    if (alert.kind === 'warn') {
      this.track(this.deliver([alert], [alert]));
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
    this.track(this.deliver([alert], [alert]));
  }

  /** `blert test`: 묶음 없이 바로 보낸다. 소리는 설정(켬/끔)을 따른다. */
  async test(kind: SoundKind): Promise<void> {
    const alert: Alert = { ruleId: 0, kind, titleKey: 'alert.test.title', params: { kind }, firedAt: iso(this.clock.now()) };
    await this.deliver([alert], [alert]);
  }

  /** `blert sound test`: 설정과 무관하게 소리만 재생한다. 재생에 실패하면 Error. */
  async soundTest(kind: SoundKind): Promise<void> {
    if (!this.opts.sound) throw new Error('sound adapter is not available');
    await this.opts.sound.play(kind);
  }

  /** 모아 둔 알림을 지금 보내고 진행 중인 전송이 끝나기를 기다린다 (종료·테스트용) */
  async flush(): Promise<void> {
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
    return this.deliver(summarize ? [this.summary(batch)] : batch, batch);
  }

  private summary(batch: Alert[]): Alert {
    const titles = batch.slice(0, SUMMARY_TOP).map((a) => render(a).title);
    const more = batch.length - titles.length;
    const list = [...titles, ...(more > 0 ? [t('alert.batch.more', { count: more })] : [])].join('\n');
    const first = batch[0]!;
    return {
      ruleId: 0,
      kind: first.kind,
      titleKey: 'alert.batch.title',
      params: { count: batch.length, list },
      firedAt: first.firedAt,
      ...(first.sound ? { sound: first.sound } : {}),
    };
  }

  private async deliver(display: Alert[], full: Alert[]): Promise<void> {
    for (const a of full) {
      const { title, body } = render(a);
      this.opts.logger?.info(LOG, `${a.kind} ${title}${body ? ` | ${body}` : ''}`);
    }
    await Promise.allSettled(
      this.opts.adapters.map(async (adapter) => {
        try {
          await adapter.send(adapter.wantsAll ? full : display);
        } catch (e) {
          this.reportFailure(adapter.name, e);
        }
      }),
    );
  }

  /** 출력 실패: 알림 본문은 콘솔이 이미 보여주므로, 원인과 해결 방법만 어댑터별로 한 번 안내한다 (B7) */
  private reportFailure(name: string, e: unknown): void {
    const reason = e instanceof Error ? e.message : String(e);
    this.opts.logger?.warn(LOG, `${name} adapter failed: ${reason}`);
    if (this.warned.has(name) || (name !== 'desktop' && name !== 'sound')) return;
    this.warned.add(name);
    const guide = t(`notify.guide.${name}.${platformGroup(this.opts.platform)}`);
    this.opts.warn(t(`notify.${name}Failed`, { reason, guide }));
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
}

/** 기본 어댑터(콘솔·데스크톱·소리)로 Notifier를 만든다 */
export function createNotifier(o: CreateNotifierOptions): Notifier {
  const clock = o.clock ?? systemClock;
  const sound = new SoundAdapter({ enabled: o.soundEnabled, dir: o.soundDir, platform: o.platform, run: o.run });
  const adapters: NotifyAdapter[] = [
    ...(o.console === false ? [] : [new ConsoleAdapter(o.out, () => clock.now())]),
    new DesktopAdapter(o.platform, o.run),
    sound,
  ];
  return new Notifier({ adapters, sound, warn: o.out, clock, logger: o.logger, platform: o.platform });
}
