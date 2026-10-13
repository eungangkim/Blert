import { BlertError } from '../shared/errors.js';
import { HISTORY_MAX_ENTRIES, type HistoryEntry } from '../shared/history.js';
import type { SoundKind } from '../shared/types.js';
import { SOUND_KINDS } from '../shared/theme.js';
import { hasMessage, t } from '../i18n/index.js';
import { formatLocalDateTime } from './format.js';
import { askYesNo } from './init.js';
import { parseDuration } from './parse.js';
import { suggest } from './suggest.js';
import type { Command, Ctx } from './types.js';

const SUBS = ['on', 'off', 'clear'] as const;
const DEFAULT_COUNT = 20;
const ICON: Record<SoundKind, string> = { up: '▲', down: '▼', account: '●', warn: '!' };

/** 한 줄로 보여 줄 글. 기록에는 문장이 아니라 키와 값이 있으므로 읽을 때 현재 언어로 만든다 (D-146) */
function describe(e: HistoryEntry, deps: Ctx['deps']): string {
  const known = hasMessage(e.titleKey);
  const { title, body } = known ? deps.renderAlert({ ruleId: e.ruleId, kind: e.kind, titleKey: e.titleKey, params: e.params, firedAt: e.ts }) : { title: t('history.unknown'), body: '' };
  const mark = e.quiet ? t(e.quiet === 'all' ? 'history.mark.all' : 'history.mark.sound') : '';
  return `${formatLocalDateTime(Date.parse(e.ts))} ${ICON[e.kind]} ${title}${body ? ` — ${body}` : ''}${mark}`;
}

function parseCount(raw: string): number {
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > HISTORY_MAX_ENTRIES) throw new BlertError('err.historyCount', { value: raw });
  return n;
}

/**
 * 알림 기록 보기 (FR-HIST-01, D-142~D-147). 조회는 파일을 읽기만 하므로 감시가 실행 중이어도 쓸 수 있다.
 */
export const historyCommand: Command = {
  name: 'history',
  usageKeys: ['usage.history.show', 'usage.history.toggle', 'usage.history.clear'],
  allowedOptions: ['since', 'kind', 'lines'],
  async run({ args, rest, deps }: Ctx) {
    const { io, store } = deps;
    const optionsGiven = args.values.has('since') || args.values.has('kind') || args.values.has('lines');

    if (rest.length > 0) {
      const sub = SUBS.find((s) => s === rest[0]!.toLowerCase());
      if (!sub) {
        const s = suggest(rest[0]!, SUBS);
        throw new BlertError(s ? 'err.historySub' : 'err.historyUsage', { value: rest[0]!, suggestion: s ?? '' });
      }
      if (rest.length > 1 || optionsGiven) throw new BlertError('err.historyUsage');

      if (sub === 'on' || sub === 'off') {
        await store.updateConfig((c) => {
          c.history = { enabled: sub === 'on' };
        });
        io.out(t(sub === 'on' ? 'history.on.done' : 'history.off.done'));
        return 0;
      }

      // clear: 지우기 전에 확인한다. 입력이 없으면 지우지 않는다 (D-145)
      const { entries } = await store.loadHistory();
      if (entries.length === 0) {
        io.out(t('history.clear.none'));
        return 0;
      }
      if (!(await askYesNo(io, t('history.clear.ask', { count: entries.length }), false))) {
        io.out(t('history.clear.cancelled'));
        return 0;
      }
      io.out(t('history.clear.done', { count: await store.clearHistory() }));
      return 0;
    }

    const sinceRaw = args.values.get('since');
    const kindRaw = args.values.get('kind');
    const countRaw = args.values.get('lines');
    const sinceMs = sinceRaw === undefined ? undefined : parseDuration(sinceRaw);
    const kind = kindRaw === undefined ? undefined : SOUND_KINDS.find((k) => k === kindRaw.toLowerCase());
    if (kindRaw !== undefined && !kind) throw new BlertError('err.historyKind', { value: kindRaw });
    const count = countRaw === undefined ? DEFAULT_COUNT : parseCount(countRaw);

    const { entries, corrupt } = await store.loadHistory();
    if (corrupt) io.out(t('history.corrupt'));
    const from = sinceMs === undefined ? undefined : deps.daemon.now() - sinceMs;
    const matched = entries.filter((e) => (from === undefined || Date.parse(e.ts) >= from) && (kind === undefined || e.kind === kind));
    const shown = matched.slice(-count).reverse(); // 최신순

    if (shown.length === 0) {
      io.out(t(entries.length === 0 ? 'history.empty' : 'history.emptyFiltered', { total: entries.length }));
    } else {
      io.out(t('history.header', { shown: shown.length, total: entries.length }));
      for (const e of shown) io.out(describe(e, deps));
    }
    if (!(await store.historyEnabled().catch(() => true))) io.out(t('history.offNote'));
    return 0;
  },
};
