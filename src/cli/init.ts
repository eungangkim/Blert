import { BlertError } from '../shared/errors.js';
import { t } from '../i18n/index.js';
import type { Command, Ctx, Io } from './types.js';

const MAX_TRIES = 3;

async function askLine(io: Io, question: string): Promise<string> {
  const line = await io.ask(question);
  if (line === null) throw new BlertError('err.noInput');
  return line.trim();
}

const words = (key: string) => t(key).split(',');

/** 예/아니오 질문. 빈 입력은 기본값, 알 수 없는 입력은 다시 묻는다. */
export async function askYesNo(io: Io, question: string, defaultYes: boolean): Promise<boolean> {
  for (let i = 0; i < MAX_TRIES; i++) {
    const a = (await askLine(io, question)).toLowerCase();
    if (a === '') return defaultYes;
    if (words('init.yesWords').includes(a)) return true;
    if (words('init.noWords').includes(a)) return false;
  }
  throw new BlertError('err.invalidAnswer');
}

/** 0이면 설치 안 함. 그 외에는 목록 번호. */
async function askChoice(io: Io, question: string, max: number): Promise<number> {
  for (let i = 0; i < MAX_TRIES; i++) {
    const a = await askLine(io, question);
    if (a === '') return 0;
    if (/^\d+$/.test(a) && Number(a) <= max) return Number(a);
  }
  throw new BlertError('err.invalidAnswer');
}

export const initCommand: Command = {
  name: 'init',
  usageKeys: ['usage.init'],
  allowedOptions: [],
  async run({ deps }: Ctx) {
    const { io, store, presets } = deps;
    io.out(t('init.disclaimer'));
    if (!(await askYesNo(io, t('init.askAgree'), false))) throw new BlertError('err.initDeclined');
    const sound = await askYesNo(io, t('init.askSound'), true);

    let installed = 0;
    const list = await presets.list();
    let chosen: string | undefined;
    if (list.length > 0) {
      io.out(t('init.askPreset'));
      list.forEach((p, i) =>
        io.out(t('init.presetLine', { n: i + 1, slug: p.slug, name: t(p.nameKey) }) + (p.installed ? t('init.presetInstalledMark') : '')),
      );
      io.out(t('init.presetNone'));
      const n = await askChoice(io, t('init.askPresetNumber'), list.length);
      const pick = n > 0 ? list[n - 1]! : undefined;
      chosen = pick && !pick.installed ? pick.slug : undefined; // 이미 설치된 프리셋은 다시 설치하지 않는다
    }

    await store.updateConfig((c) => {
      c.disclaimerAccepted = true;
      c.soundEnabled = sound;
    });
    if (chosen) installed = await presets.install(chosen);

    io.out(t('init.done', { count: installed }));
    io.out(t('init.next'));
    return 0;
  },
};
