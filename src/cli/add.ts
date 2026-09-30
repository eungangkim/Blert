import { BlertError } from '../shared/errors.js';
import type { Rule, SoundKind } from '../shared/types.js';
import { DEFAULT_REPEAT } from '../shared/defaults.js';
import { t } from '../i18n/index.js';
import { suggest } from './suggest.js';
import { parseDirection, parseMode, parseMultiple, parsePercent, parsePrice, parseSymbol, parseWindow } from './parse.js';
import type { Command, Ctx } from './types.js';
import { describeRule } from './format.js';

const TYPES = ['price', 'change', 'volume', 'funding'] as const;
type AddType = (typeof TYPES)[number];
const SOUNDS = ['up', 'down', 'account', 'warn', 'off'] as const;

export type RuleDraft = Omit<Rule, 'id' | 'createdAt'>;

function usageError(type: AddType): BlertError {
  return new BlertError('err.usage', { usage: t(`usage.add.${type}`), example: t(`example.add.${type}`) });
}

/** `blert add <유형> ...`의 위치 인자와 옵션을 규칙 초안으로 바꾼다. */
export function buildRule(rest: string[], values: Map<string, string>): RuleDraft {
  const typeRaw = rest[0];
  if (!typeRaw) throw new BlertError('err.addMissingType', { types: TYPES.join(', ') });
  const type = TYPES.find((x) => x === typeRaw.toLowerCase());
  if (!type) {
    const s = suggest(typeRaw, TYPES);
    throw s
      ? new BlertError('err.addTypeDidYouMean', { value: typeRaw, suggestion: s })
      : new BlertError('err.addType', { value: typeRaw, types: TYPES.join(', ') });
  }
  const a = rest.slice(1);
  const need = (ok: boolean) => {
    if (!ok) throw usageError(type);
  };

  let draft: Pick<RuleDraft, 'type' | 'market' | 'symbol' | 'condition'>;
  switch (type) {
    case 'price': {
      need(a.length === 3);
      const { market, symbol } = parseSymbol(a[0]!);
      const direction = parseDirection(a[1]!, ['above', 'below'] as const);
      draft = { type, market, symbol, condition: { type, direction, price: parsePrice(a[2]!) } };
      break;
    }
    case 'change': {
      need(a.length === 3 || a.length === 4);
      const { market, symbol } = parseSymbol(a[0]!);
      const pct = parsePercent(a[1]!);
      const windowMs = parseWindow(a[2]!);
      const direction = a[3] === undefined ? 'both' : parseDirection(a[3], ['up', 'down'] as const);
      draft = { type, market, symbol, condition: { type, pct, windowMs, direction } };
      break;
    }
    case 'volume': {
      need(a.length === 2 || a.length === 3);
      const { market, symbol } = parseSymbol(a[0]!);
      const multiple = parseMultiple(a[1]!);
      const parts = (a[2] ?? '5m/1h').split('/');
      need(parts.length === 2);
      const shortMs = parseWindow(parts[0]!);
      const longMs = parseWindow(parts[1]!);
      if (shortMs >= longMs) throw new BlertError('err.volumeRange', { value: a[2] ?? '5m/1h' });
      draft = { type, market, symbol, condition: { type, multiple, shortMs, longMs } };
      break;
    }
    case 'funding': {
      need(a.length === 3);
      const { market, symbol } = parseSymbol(a[0]!);
      if (market !== 'futures') throw new BlertError('err.fundingFutures', { value: a[0]! });
      const direction = parseDirection(a[1]!, ['above', 'below'] as const);
      draft = { type, market, symbol, condition: { type, direction, pct: parsePercent(a[2]!, true) } };
      break;
    }
  }

  const modeRaw = values.get('mode');
  const soundRaw = values.get('sound');
  const nameRaw = values.get('name');
  const sound = soundRaw === undefined ? undefined : parseDirection(soundRaw, SOUNDS);
  return {
    ...draft,
    repeat: modeRaw === undefined ? DEFAULT_REPEAT[type] : parseMode(modeRaw),
    ...(sound ? { sound: sound as SoundKind | 'off' } : {}),
    ...(nameRaw ? { name: nameRaw } : {}),
    source: 'manual',
    enabled: true,
  };
}

export const addCommand: Command = {
  name: 'add',
  usageKeys: ['usage.add.price', 'usage.add.change', 'usage.add.volume', 'usage.add.funding'],
  allowedOptions: ['mode', 'sound', 'name'],
  advancedKeys: ['help.advanced.mode', 'help.advanced.sound', 'help.advanced.name'],
  async run({ rest, args, deps }: Ctx) {
    const draft = buildRule(rest, args.values);
    const [rule] = await deps.store.addRules([draft]);
    deps.io.out(t('add.done', { id: rule!.id, summary: describeRule(rule!) }));
    deps.io.out(t('add.next'));
    return 0;
  },
};
