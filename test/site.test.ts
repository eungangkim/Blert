import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildIndex, FORBIDDEN_WORDING, type GalleryIndex } from '../gallery/scripts/lib.js';
import { EN, KO, PAGES } from '../site/content.js';
import { esc, pick, rawUrl, renderSite } from '../site/build.js';

// 정적 사이트 (계획 3단계, D-87, D-133). 수용 기준 번호가 없는 항목이라 결정 번호로 시작한다.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'a'.repeat(40);

const text = (html: string): string => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ');

async function site() {
  const { index } = await buildIndex(join(ROOT, 'gallery'));
  return { index, files: renderSite(index, REF) };
}

describe('정적 사이트 (D-133)', () => {
  it('D-133 한국어·영어가 같은 5개 페이지를 만든다', async () => {
    const { files } = await site();
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([...PAGES.map((p) => `${p}.html`), ...PAGES.map((p) => `en/${p}.html`)].sort());
  });

  it('D-133 한국어·영어 문구의 구조(항목 수)가 같다', () => {
    expect(EN.home.features).toHaveLength(KO.home.features.length);
    expect(EN.start.steps).toHaveLength(KO.start.steps.length);
    expect(EN.trust.sections.map((s) => s.items.length)).toEqual(KO.trust.sections.map((s) => s.items.length));
    expect(EN.privacy.body).toHaveLength(KO.privacy.body.length);
    expect(Object.keys(EN.gallery.themeText)).toEqual(Object.keys(KO.gallery.themeText));
    expect(Object.keys(EN.gallery.typeNames)).toEqual(Object.keys(KO.gallery.typeNames));
  });

  it('D-133 외부 자원을 불러오지 않고(글꼴·스크립트·이미지·분석 없음) 엄격한 CSP를 둔다', async () => {
    const { files } = await site();
    for (const f of files) {
      expect(f.html, f.path).toContain("default-src 'none'");
      expect(f.html, f.path).not.toMatch(/<(script|img|iframe|embed|object|source|video|audio)\b[^>]*\b(src|data)=["']?(https?:)?\/\//i);
      expect(f.html, f.path).not.toMatch(/<link\b[^>]*\bhref=["']?https?:/i);
      expect(f.html, f.path).not.toMatch(/<form\b/i);
      expect(f.html, f.path).not.toMatch(/<script(?![^>]*\bsrc=)/i); // 인라인 스크립트 없음
      for (const m of f.html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
        const url = m[1]!;
        if (/^https?:/.test(url)) expect(url, f.path).toMatch(/^https:\/\/(github\.com\/eungangkim\/Blert|www\.npmjs\.com\/package\/@eungang\/blert|raw\.githubusercontent\.com\/eungangkim\/Blert)/);
      }
    }
    const css = await readFile(join(ROOT, 'site', 'style.css'), 'utf8');
    expect(css).not.toMatch(/@import|url\(/);
    const js = await readFile(join(ROOT, 'site', 'app.js'), 'utf8');
    expect(js).not.toMatch(/https?:\/\/|fetch\(|XMLHttpRequest|sendBeacon|localStorage|document\.cookie/);
  });

  it('D-133 모든 페이지에 투자 조언 아님 고지와 바이낸스 제휴 없음 문구가 있다', async () => {
    const { files } = await site();
    for (const f of files) {
      const c = f.path.startsWith('en/') ? EN : KO;
      expect(f.html, f.path).toContain(esc(c.footer.disclaimer));
      expect(f.html, f.path).toContain(esc(c.footer.affiliation));
    }
  });

  it('D-133 페이지 문구에 권유·보장으로 읽힐 수 있는 표현이 없다 (D-87⑤)', async () => {
    const { files } = await site();
    for (const f of files) expect(text(f.html), f.path).not.toMatch(FORBIDDEN_WORDING);
  });

  it('D-133 영어 페이지에는 언어 전환 링크 말고는 한글이 없다', async () => {
    const { files } = await site();
    for (const f of files.filter((x) => x.path.startsWith('en/'))) {
      const body = f.html.replace(/<a class="lang"[^>]*>[^<]*<\/a>/, '');
      expect(body, f.path).not.toMatch(/[가-힣]/);
    }
  });

  it('D-133 갤러리 설치 명령은 고정한 커밋 주소와 index.json의 해시를 쓴다', async () => {
    const { index, files } = await site();
    for (const lang of ['gallery.html', 'en/gallery.html']) {
      const html = files.find((f) => f.path === lang)!.html;
      for (const p of index.presets) {
        expect(html).toContain(`blert preset install ${rawUrl(REF, p.file)} --sha256 ${p.sha256}`);
      }
      for (const t of index.themes) expect(html).toContain(`blert sound theme ${rawUrl(REF, t.file)}`);
      expect(html).not.toContain('raw.githubusercontent.com/eungangkim/Blert/main');
    }
    expect(rawUrl(REF, 'presets/x.json')).toBe(`https://raw.githubusercontent.com/eungangkim/Blert/${REF}/gallery/presets/x.json`);
  });

  it('D-133 갤러리 항목은 계정 키 필요 여부와 필요한 blert 버전을 보여 준다', async () => {
    const { files } = await site();
    const ko = files.find((f) => f.path === 'gallery.html')!.html;
    expect(ko).toContain('읽기 전용 API 키 필요');
    expect(ko).toContain('API 키 없이 동작');
    expect(ko).toContain('blert 1.2 이상 필요');
    expect(ko).toContain('blert 1.1 이상 필요');
    const en = files.find((f) => f.path === 'en/gallery.html')!.html;
    expect(en).toContain('Needs a read-only API key');
    expect(en).toContain('Liquidation guard');
    expect(en).not.toContain('청산 단계 경고');
  });

  it('D-133 갤러리 값에 들어 있는 HTML은 이스케이프된다', () => {
    const evil: GalleryIndex = {
      schemaVersion: 1,
      presets: [{ slug: 'x-y-z', name: '<img src=x onerror=alert(1)>', description: '"><script>alert(1)</script>', license: 'CC0-1.0', version: 1, file: 'presets/x-y-z.json', sha256: 'b'.repeat(64), bytes: 1, ruleCount: 1, types: { price: 1 }, needsKey: false }],
      themes: [],
    };
    for (const f of renderSite(evil, REF).filter((x) => x.path.endsWith('gallery.html'))) {
      expect(f.html).not.toContain('<img src=x');
      expect(f.html).not.toContain('<script>alert');
      expect(f.html).toContain('&lt;img src=x');
    }
  });

  it('D-133 프리셋 이름·설명은 언어에 맞는 쪽을 고른다', () => {
    expect(pick('ko', '청산 단계 경고 (Liquidation guard)', 'name')).toBe('청산 단계 경고');
    expect(pick('en', '청산 단계 경고 (Liquidation guard)', 'name')).toBe('Liquidation guard');
    expect(pick('en', '한국어 문장. / English sentence.', 'description')).toBe('English sentence.');
    expect(pick('ko', '그냥 이름', 'name')).toBe('그냥 이름');
  });

  it('D-133 사이트 문구가 말하는 사실이 저장소와 맞는다 (런타임 의존성 수, 설치 명령)', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { name: string; dependencies: Record<string, string> };
    const count = Object.keys(pkg.dependencies).length;
    expect(KO.trust.sections.flatMap((s) => s.items).join()).toContain(`현재 ${count}개`);
    expect(EN.trust.sections.flatMap((s) => s.items).join()).toContain(`currently ${count}`);
    const { files } = await site();
    expect(files.find((f) => f.path === 'index.html')!.html).toContain(`npx ${pkg.name} init`);
  });
});
