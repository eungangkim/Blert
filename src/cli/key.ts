import { promises as fs } from 'node:fs';
import { BlertError } from '../shared/errors.js';
import { DEFAULT_KEY_REF } from '../security/index.js';
import { t } from '../i18n/index.js';
import { suggest } from './suggest.js';
import type { Command, Ctx, Io } from './types.js';

const SUBS = ['add', 'remove', 'check'] as const;
const MAX_PEM_BYTES = 16 * 1024;

async function askLine(io: Io, question: string): Promise<string> {
  const line = await io.ask(question);
  if (line === null) throw new BlertError('err.noInput');
  return line.trim();
}

/** 따옴표로 감싼 경로(Windows 탐색기 '경로로 복사')도 받는다 */
async function readPem(rawPath: string): Promise<{ path: string; pem: string }> {
  const path = rawPath.trim().replace(/^["']|["']$/g, '');
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > MAX_PEM_BYTES) throw new Error('not a key file');
    return { path, pem: await fs.readFile(path, 'utf8') };
  } catch {
    throw new BlertError('err.keyFile', { path });
  }
}

export const keyCommand: Command = {
  name: 'key',
  usageKeys: ['usage.key.add', 'usage.key.remove', 'usage.key.check'],
  allowedOptions: [],
  async run({ rest, deps }: Ctx) {
    const { io, store, keys } = deps;
    const [subRaw, ...extra] = rest;
    const sub = SUBS.find((s) => s === subRaw?.toLowerCase());
    if (!sub) {
      if (!subRaw) throw new BlertError('err.usage', { usage: t('usage.key.add'), example: t('example.key.add') });
      const s = suggest(subRaw, SUBS);
      throw new BlertError(s ? 'err.keySubDidYouMean' : 'err.keySub', { value: subRaw, suggestion: s ?? '', subs: SUBS.join(', ') });
    }
    if (extra.length > 0) throw new BlertError('err.usage', { usage: t(`usage.key.${sub}`), example: t(`example.key.${sub}`) });
    if (deps.network === 'testnet') io.out(t('key.testnetBanner'));

    if (sub === 'add') {
      // 비밀은 명령줄 인자로 받지 않는다(셸 히스토리에 남음). 개인키는 파일 경로로만 받는다.
      const apiKey = await askLine(io, t('key.promptApiKey'));
      const { path, pem } = await readPem(await askLine(io, t('key.promptPem')));
      const replacing = (await store.loadConfig()).keyRef !== undefined;
      const result = await keys.add({ apiKey, privateKeyPem: pem });
      await store.updateConfig((c) => {
        c.keyRef = DEFAULT_KEY_REF; // 설정 파일에는 참조 이름만 둔다
      });
      io.out(t('key.added'));
      if (replacing) io.out(t('key.replaced'));
      if (!result.checked) io.out(t('key.testnetSkipped'));
      else if (result.ipRestricted === false) io.out(t('key.ipWarning'));
      io.out(t('key.deleteFile', { path }));
      return 0;
    }

    if (sub === 'remove') {
      const removed = await keys.remove();
      await store.updateConfig((c) => {
        delete c.keyRef;
      });
      io.out(t(removed ? 'key.removed' : 'key.noneToRemove'));
      const accountRules = (await store.loadRules()).filter((r) => r.type === 'fill' || r.type === 'balance' || r.type === 'liq').length;
      if (removed && accountRules > 0) io.out(t('key.accountRulesNote', { count: accountRules }));
      return 0;
    }

    const result = await keys.check();
    // 테스트넷은 권한을 확인하지 않았으므로 '읽기 전용'이라고 말하지 않는다
    if (!result.checked) io.out(t('key.checkSkipped'));
    else {
      io.out(t('key.checkOk'));
      if (result.ipRestricted === false) io.out(t('key.ipWarning'));
    }
    return 0;
  },
};
