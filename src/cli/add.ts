import { BlertError } from '../shared/errors.js';
import type { Rule, SoundKind } from '../shared/types.js';
import { DEFAULT_REPEAT } from '../shared/defaults.js';
import { t } from '../i18n/index.js';
import { suggest } from './suggest.js';
import { parseDirection, parseMode, parseMultiple, parsePercent, parsePrice, parseSymbol, parseWindow } from './parse.js';
import type { Command, Ctx } from './types.js';
import { describeRule } from './format.js';

const TYPES = ['price', 'change', 'volume', 'funding', 'fill', 'balance', 'liq'] as const;
type AddType = (typeof TYPES)[number];
const SOUNDS = ['up', 'down', 'account', 'warn', 'off'] as const;

export type RuleDraft = Omit<Rule, 'id' | 'createdAt'>;

function usageError(type: AddType): BlertError {
  return new BlertError('err.usage', { usage: t(`usage.add.${type}`), example: t(`example.add.${type}`) });
}

/** `blert add <유형> ...`의 위치 인자와 옵션을 규칙 초안으로 바꾼다. */
/** `all` 또는 자산 이름(BTC, USDT …). 자산은 대문자로 정규화한다. */
function parseAsset(raw: string): string {
  if (raw.toLowerCase() === 'all') return '*';
  if (!/^[A-Za-z0-9]{2,10}$/.test(raw)) throw new BlertError('err.asset', { value: raw });
  return raw.toUpperCase();
}

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
  // 계정 알림은 반복 정책이 정해져 있다 (체결은 이벤트마다, 잔고는 쿨다운 10분 — B4, D-27)
  if ((type === 'fill' || type === 'balance') && values.has('mode')) throw new BlertError('err.modeFixed', { type });
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
    case 'fill': {
      need(a.length === 1);
      if (a[0]!.toLowerCase() === 'all') {
        draft = { type, market: 'spot', symbol: '*', condition: { type } };
      } else if (a[0]!.toLowerCase() === 'f:all') {
        throw new BlertError('err.fillFuturesAll', { value: a[0]! }); // 선물은 심볼을 지정해야 한다 (D-52)
      } else {
        const { market, symbol } = parseSymbol(a[0]!);
        draft = { type, market, symbol, condition: { type } };
      }
      break;
    }
    case 'liq': {
      need(a.length === 2);
      const { market, symbol } = parseSymbol(a[0]!);
      if (market !== 'futures') throw new BlertError('err.liqFutures', { value: a[0]! });
      const pct = parsePercent(a[1]!);
      if (pct >= 100) throw new BlertError('err.liqRange', { value: a[1]! });
      draft = { type, market, symbol, condition: { type, pct } };
      break;
    }
    case 'balance': {
      need(a.length === 2);
      draft = { type, market: 'spot', symbol: '*', condition: { type, asset: parseAsset(a[0]!), pct: parsePercent(a[1]!) } };
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
  usageKeys: ['usage.add.price', 'usage.add.change', 'usage.add.volume', 'usage.add.funding', 'usage.add.fill', 'usage.add.balance', 'usage.add.liq'],
  allowedOptions: ['mode', 'sound', 'name'],
  advancedKeys: ['help.advanced.mode', 'help.advanced.sound', 'help.advanced.name'],
  async run({ rest, args, deps }: Ctx) {
    const draft = buildRule(rest, args.values);
    const [rule] = await deps.store.addRules([draft]);
    deps.io.out(t('add.done', { id: rule!.id, summary: describeRule(rule!) }));
    // 계정 알림은 API 키가 있어야 동작한다. 키가 없으면 등록 방법을 안내한다.
    if ((rule!.type === 'fill' || rule!.type === 'balance' || rule!.type === 'liq') && (await deps.store.loadConfig()).keyRef === undefined) {
      deps.io.out(t('add.needKey'));
    }
    deps.io.out(t('add.next'));
    return 0;
  },
};
