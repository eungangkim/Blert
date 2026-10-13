import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeHarness, type Harness } from './helpers.js';
import { setLanguage } from '../../src/i18n/index.js';
import { createNotifier } from '../../src/notify/index.js';
import { HistoryRecorder } from '../../src/store/index.js';
import type { HistoryEntry } from '../../src/shared/history.js';
import type { Alert } from '../../src/shared/types.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const HOUR = 3_600_000;
const text = (x: Harness): string => [...x.out, ...x.err].join('\n');
const price = (ago: number, h2: Harness, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  ts: new Date(h2.sim.nowMs - ago).toISOString(),
  ruleId: 1,
  kind: 'up',
  titleKey: 'alert.price.above.title',
  params: { coin: 'BTC', quote: 'USDT', market: 'spot', target: '70,000', price: '70,012' },
  ...over,
});
const put = async (x: Harness, ...e: HistoryEntry[]): Promise<void> => x.deps.store.appendHistory(e);

describe('cli history 조회 (FR-HIST-01, D-147)', () => {
  it('AC-125 기록이 없으면 안내 문장과 예시를 보여 준다', async () => {
    h = await makeHarness();
    expect(await h.run('history')).toBe(0);
    expect(h.out[0]).toContain('기록된 알림이 없습니다');
    expect(h.out[0]).toContain('예: blert history --since 6h');
  });

  it('AC-125 최신순으로 보여 주고 제목·본문은 기록한 값으로 만든다. 조용히 처리된 알림에는 표시가 붙는다', async () => {
    h = await makeHarness();
    await put(h, price(3 * HOUR, h, { ruleId: 1 }), price(2 * HOUR, h, { ruleId: 2, kind: 'down', quiet: 'sound' }), price(HOUR, h, { ruleId: 3, kind: 'warn', quiet: 'all' }));
    expect(await h.run('history')).toBe(0);
    expect(h.out[0]).toBe('알림 기록 3건 (전체 3건)');
    expect(h.out).toHaveLength(4);
    expect(h.out[1]).toContain('! ');
    expect(h.out[1]).toContain('(조용히 처리됨)');
    expect(h.out[2]).toContain('▼ ');
    expect(h.out[2]).toContain('(소리·음성 꺼짐)');
    expect(h.out[3]).toContain('▲ ');
    expect(h.out[3]).not.toContain('(');
    expect(h.out[3]).toContain('BTC');
  });

  it('AC-125 --since, --kind, -n 필터가 동작하고 서로 함께 쓸 수 있다', async () => {
    h = await makeHarness();
    await put(h, price(10 * HOUR, h, { ruleId: 1 }), price(5 * HOUR, h, { ruleId: 2, kind: 'warn' }), price(2 * HOUR, h, { ruleId: 3, kind: 'warn' }), price(HOUR, h, { ruleId: 4 }));
    await h.run('history --since 6h');
    expect(h.out[0]).toBe('알림 기록 3건 (전체 4건)');
    h.out.length = 0;
    await h.run('history --kind warn');
    expect(h.out[0]).toBe('알림 기록 2건 (전체 4건)');
    h.out.length = 0;
    await h.run('history -n 1');
    expect(h.out[0]).toBe('알림 기록 1건 (전체 4건)');
    h.out.length = 0;
    await h.run('history --since 6h --kind warn -n 1');
    expect(h.out).toHaveLength(2);
    h.out.length = 0;
    await h.run('history --kind WARN');
    expect(h.out[0]).toBe('알림 기록 2건 (전체 4건)');
    h.out.length = 0;
    await h.run('history --since 30m');
    expect(h.out[0]).toContain('조건에 맞는 기록이 없습니다(전체 4건)');
  });

  it('AC-125 잘못된 값은 종료 코드 1과 예시를 안내한다', async () => {
    h = await makeHarness();
    for (const bad of ['--kind loud', '--since abc', '-n 0', '-n 2001', '-n x', '-n 1.5', '--since', '--kind']) {
      h.err.length = 0;
      expect(await h.run(`history ${bad}`), bad).toBe(1);
      expect(h.err.at(-1), bad).toContain('예');
    }
  });

  it('AC-126 언어를 바꾸면 과거 기록도 새 언어로 보이고, 키가 없는 옛 항목은 알 수 없는 알림으로 보인다', async () => {
    h = await makeHarness();
    await put(h, price(HOUR, h), price(2 * HOUR, h, { ruleId: 2, titleKey: 'alert.removed.long.ago.title', params: {} }));
    await h.run('history');
    expect(h.out.join('\n')).toMatch(/[가-힣]/);
    expect(h.out[1]).toContain('BTC');
    expect(h.out[2]).toContain('알 수 없는 알림');
    h.out.length = 0;
    setLanguage('en');
    await h.run('history');
    expect(h.out[0]).toBe('Alert history: 2 shown (2 total)');
    expect(h.out[1]).toContain('BTC');
    expect(h.out[2]).toContain('Unknown alert');
    expect(h.out.join('\n')).not.toMatch(/[가-힣]/);
  });

  it('AC-127 기록 파일이 손상돼 있으면 조회는 그렇게 알려 주고 파일은 건드리지 않는다', async () => {
    h = await makeHarness();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(h.dir, 'history.json'), '{ broken');
    expect(await h.run('history')).toBe(0);
    expect(h.out[0]).toContain('기록 파일을 읽을 수 없어');
    expect(await readFile(join(h.dir, 'history.json'), 'utf8')).toBe('{ broken');
  });
});

describe('cli history on·off·clear (D-145)', () => {
  it('AC-128 history off는 설정에 저장하고 조회 끝에 꺼져 있다고 알려 준다. on으로 되돌린다', async () => {
    h = await makeHarness();
    expect(await h.deps.store.historyEnabled()).toBe(true);
    expect(await h.run('history off')).toBe(0);
    expect(h.out[0]).toContain('알림 기록을 껐습니다');
    expect(await h.deps.store.historyEnabled()).toBe(false);
    h.out.length = 0;
    await h.run('history');
    expect(h.out.at(-1)).toContain('기록이 꺼져 있어');
    h.out.length = 0;
    expect(await h.run('history on')).toBe(0);
    expect(await h.deps.store.historyEnabled()).toBe(true);
    expect(h.out[0]).toContain('알림 기록을 켰습니다');
  });

  it('AC-128 history clear는 확인(y)을 받은 뒤에만 지운다', async () => {
    h = await makeHarness(['y']);
    await put(h, price(HOUR, h), price(2 * HOUR, h, { ruleId: 2 }));
    expect(await h.run('history clear')).toBe(0);
    expect(h.asked[0]).toBe('알림 기록 2건을 모두 지웁니다. 계속할까요? (y/N) ');
    expect(h.out.at(-1)).toBe('알림 기록 2건을 지웠습니다.');
    expect((await h.deps.store.loadHistory()).entries).toEqual([]);
  });

  it('AC-128 n이나 빈 입력이면 지우지 않고, 입력이 없거나 알 수 없는 답이면 오류로 끝내며 지우지 않는다', async () => {
    for (const [answers, code] of [[['n'], 0], [[''], 0], [[] as string[], 1], [['yes please?'], 1]] as const) {
      h = await makeHarness([...answers]);
      await put(h, price(HOUR, h));
      expect(await h.run('history clear'), answers.join()).toBe(code);
      if (code === 0) expect(h.out.at(-1)).toBe('지우지 않았습니다.');
      expect((await h.deps.store.loadHistory()).entries).toHaveLength(1);
      await h.cleanup();
    }
    h = undefined;
  });

  it('AC-128 지울 기록이 없으면 묻지 않고 알려 준다', async () => {
    h = await makeHarness();
    expect(await h.run('history clear')).toBe(0);
    expect(h.out[0]).toBe('지울 기록이 없습니다.');
    expect(h.asked).toHaveLength(0);
  });

  it('AC-125 on·off·clear에는 옵션이나 다른 인자를 쓸 수 없고, 하위 명령 오타는 제안한다', async () => {
    h = await makeHarness();
    for (const bad of ['history on --since 1h', 'history off now', 'history clear -n 5', 'history foo']) {
      h.err.length = 0;
      expect(await h.run(bad), bad).toBe(1);
      expect(h.err.at(-1), bad).toContain('예');
    }
    h.err.length = 0;
    await h.run('history offf');
    expect(h.err.at(-1)).toContain('혹시 `off`?');
  });
});

describe('알림 → 기록 → 조회 (AC-124, AC-129)', () => {
  const alert = (kind: Alert['kind'], over: Partial<Alert> = {}): Alert => ({
    ruleId: 1,
    kind,
    titleKey: 'alert.price.above.title',
    params: { coin: 'BTC', quote: 'USDT', market: 'spot', target: '70,000', price: '70,012' },
    firedAt: new Date().toISOString(),
    ...over,
  });

  it('AC-124 실제 알림 경로로 보낸 알림이 기록 파일에 쌓이고 history로 조회된다. 조용히 처리된 것에는 표시가 붙는다', async () => {
    h = await makeHarness();
    const store = h.deps.store;
    const recorder = new HistoryRecorder({ append: (e) => store.appendHistory(e), enabled: () => store.historyEnabled() });
    let quiet = false;
    const notifier = createNotifier({
      out: () => {},
      soundEnabled: () => false,
      console: false,
      platform: 'linux',
      run: async () => {}, // 실제 알림·소리를 띄우지 않는다
      quiet: () => (quiet ? { all: false, includeWarn: false } : undefined),
      record: (e) => recorder.add(e),
    });
    notifier.notify(alert('up', { ruleId: 1 }));
    await notifier.flush();
    quiet = true;
    notifier.notify(alert('down', { ruleId: 2 }));
    notifier.notify(alert('warn', { ruleId: 3 })); // warn은 조용한 시간에도 정상
    await notifier.flush();
    notifier.announce(alert('up', { titleKey: 'alert.start.title', params: {} })); // 공지는 기록하지 않는다
    await notifier.flush();
    await recorder.flush();

    const { entries } = await store.loadHistory();
    // warn은 바로, 나머지는 잠깐 모았다가 나가므로 쌓인 순서가 아니라 규칙 번호로 비교한다
    expect(entries.map((e) => [e.ruleId, e.quiet]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([[1, undefined], [2, 'sound'], [3, undefined]]);

    h.sim.nowMs = Date.now();
    await h.run('history');
    expect(h.out[0]).toBe('알림 기록 3건 (전체 3건)');
    expect(h.out.join('\n')).toContain('(소리·음성 꺼짐)');
  });

  it('AC-129 기록 파일에는 정해진 항목만 있고 조회·기록에 네트워크 요청이 없다', async () => {
    h = await makeHarness();
    await put(h, price(HOUR, h, { kind: 'account', titleKey: 'alert.fill.title', params: { coin: 'BTC', qty: '0.015', price: '68,420', side: 'BUY', market: 'spot' } }));
    await h.run('history');
    await h.run('history --kind account');
    const file = JSON.parse(await readFile(join(h.dir, 'history.json'), 'utf8'));
    expect(Object.keys(file).sort()).toEqual(['entries', 'schemaVersion']);
    expect(Object.keys(file.entries[0]).sort()).toEqual(['kind', 'params', 'ruleId', 'titleKey', 'ts']);
    expect(h.fetchCalls()).toBe(0);
  });
});

describe('history 영어 (AC-131)', () => {
  it('AC-131 history의 출력과 오류에 한글이 없고 오류는 예시(e.g.)를 담는다', async () => {
    h = await makeHarness(['y']);
    setLanguage('en');
    await put(h, price(HOUR, h, { quiet: 'all' }));
    for (const c of ['history', 'history --since 6h --kind up -n 3', 'history --kind warn', 'history off', 'history', 'history on', 'history clear']) {
      expect(await h.run(c), c).toBe(0);
    }
    for (const c of ['history --kind loud', 'history -n 0', 'history --since abc', 'history foo', 'history on now', 'history offf']) {
      expect(await h.run(c), c).toBe(1);
    }
    expect(text(h)).not.toMatch(/[가-힣]/);
    expect(h.err.every((e) => /e\.g\./.test(e)), h.err.join('\n')).toBe(true);
    expect(h.out.join('\n')).toContain('Alert history: 1 shown');
    expect(h.out.join('\n')).toContain('(silenced)');
    expect(h.out.join('\n')).toContain('Deleted 1 recorded alerts.');
  });

  it('AC-131 도움말에 history가 나온다', async () => {
    h = await makeHarness();
    setLanguage('en');
    await h.run('--help');
    expect(h.out.join('\n')).toMatch(/history\s+Show the alerts that fired/);
    h.out.length = 0;
    await h.run('history --help');
    expect(h.out.join('\n')).toContain('blert history --kind warn -n 5');
  });
});
