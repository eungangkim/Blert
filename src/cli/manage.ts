import { BlertError } from '../shared/errors.js';
import type { Rule } from '../shared/types.js';
import { t } from '../i18n/index.js';
import { suggest } from './suggest.js';
import { describeCondition, describeRepeat, renderTable, symbolLabel } from './format.js';
import type { Command, Ctx } from './types.js';

type Status = 'active' | 'paused' | 'fired';

/** 알림 지정: 목록의 ID 또는 all */
function parseTarget(rest: string[], command: string): number | 'all' {
  const raw = rest[0];
  if (rest.length !== 1 || raw === undefined) {
    throw new BlertError('err.usage', { usage: t(`usage.${command}`), example: t(`example.${command}`) });
  }
  if (raw.toLowerCase() === 'all') return 'all';
  if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  const s = suggest(raw, ['all']);
  throw new BlertError(s ? 'err.targetDidYouMean' : 'err.target', { value: raw, command, suggestion: s ?? '' });
}

export const listCommand: Command = {
  name: 'list',
  usageKeys: ['usage.list'],
  allowedOptions: ['all'],
  async run({ args, deps }: Ctx) {
    const [rules, states] = await Promise.all([deps.store.loadRules(), deps.store.loadStates()]);
    const fired = new Set(states.filter((s) => s.lastFiredAt).map((s) => s.ruleId));
    // 1회성이 발동해 꺼진 규칙만 '비활성'이고, 사용자가 멈춘 규칙은 '일시정지'로 보여준다.
    const statusOf = (r: Rule): Status => (r.enabled ? 'active' : r.repeat.kind === 'once' && fired.has(r.id) ? 'fired' : 'paused');
    const shown = args.flags.has('all') ? rules : rules.filter((r) => statusOf(r) !== 'fired');
    const hidden = rules.length - shown.length;

    if (shown.length === 0) {
      deps.io.out(t('list.empty'));
    } else {
      const header = ['id', 'status', 'type', 'market', 'symbol', 'cond', 'repeat', 'source'].map((k) => t(`list.col.${k}`));
      const body = shown.map((r) => [
        String(r.id),
        t(`list.status.${statusOf(r)}`),
        t(`type.${r.type}`),
        t(`market.${r.market}`),
        r.name ? t('list.symbolWithName', { symbol: symbolLabel(r) || '-', name: r.name }) : symbolLabel(r) || '-',
        describeCondition(r.condition),
        describeRepeat(r.repeat),
        r.source === 'manual' ? t('list.source.manual') : r.source,
      ]);
      deps.io.out(renderTable([header, ...body]));
    }
    if (hidden > 0) deps.io.out(t('list.hiddenNote', { count: hidden }));
    return 0;
  },
};

function manageCommand(name: 'del' | 'pause' | 'resume', act: (ctx: Ctx, target: number | 'all') => Promise<number[]>): Command {
  return {
    name,
    usageKeys: [`usage.${name}`],
    allowedOptions: [],
    async run(ctx) {
      const ids = await act(ctx, parseTarget(ctx.rest, name));
      ctx.deps.io.out(ids.length ? t(`${name}.done`, { count: ids.length }) : t('manage.none'));
      return 0;
    },
  };
}

export const delCommand = manageCommand('del', (c, target) => c.deps.store.deleteRules(target));
export const pauseCommand = manageCommand('pause', (c, target) => c.deps.store.setEnabled(target, false));
export const resumeCommand = manageCommand('resume', (c, target) => c.deps.store.setEnabled(target, true));
