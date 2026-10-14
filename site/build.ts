import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, type GalleryIndex, type PresetEntry, type ThemeEntry } from '../gallery/scripts/lib.js';
import { EN, KO, NPM, PAGES, REPO, type Lang, type PageId } from './content.js';
import { SPONSORS, type Sponsor } from './sponsors.js';

/**
 * 정적 사이트를 만든다 (D-133, 계획 3단계). 외부 요청(글꼴, 분석, CDN)이 없는 순수 HTML·CSS·JS다.
 *   npm run site:build   → site/out/ (한국어는 루트, 영어는 en/)
 * 갤러리는 gallery/index.json 기준이고, 설치 명령은 GALLERY_REF(기본: 현재 커밋)에 고정한 주소를 쓴다 (D-85).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RAW = 'https://raw.githubusercontent.com/eungangkim/Blert';

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fill = (s: string, vars: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);

const content = (lang: Lang) => (lang === 'ko' ? KO : EN);
const fileName = (id: PageId): string => `${id}.html`;
/** 홈은 폴더 기준 index.html, 영어 페이지는 en/ 아래에 둔다. 모두 상대 경로라 어느 하위 경로에 올려도 동작한다 */
const prefixTo = (lang: Lang): string => (lang === 'en' ? '../' : '');

/** 프리셋 이름·설명은 "한국어 (English)", "한국어 / English" 형태로 한 파일에 담겨 있다. 언어에 맞는 쪽을 고른다 */
export function pick(lang: Lang, text: string, kind: 'name' | 'description'): string {
  if (kind === 'name') {
    const m = /^(.*?)\s*\((.+)\)\s*$/.exec(text);
    return m ? (lang === 'ko' ? m[1]! : m[2]!) : text;
  }
  const parts = text.split(' / ');
  return parts.length === 2 ? (lang === 'ko' ? parts[0]! : parts[1]!) : text;
}

function layout(lang: Lang, id: PageId, body: string): string {
  const c = content(lang);
  const up = prefixTo(lang);
  const other: Lang = lang === 'ko' ? 'en' : 'ko';
  const switchHref = lang === 'ko' ? `en/${fileName(id)}` : `../${fileName(id)}`;
  const nav = PAGES.map((p) => `<a href="${fileName(p)}"${p === id ? ' aria-current="page"' : ''}>${esc(c.nav[p])}</a>`).join('');
  const alt = (l: Lang): string => (l === 'en' ? `en/${fileName(id)}` : fileName(id));
  return `<!doctype html>
<html lang="${c.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'">
<title>${esc(c.titles[id])}</title>
<meta name="description" content="${esc(c.descriptions[id])}">
<meta name="referrer" content="no-referrer">
<link rel="stylesheet" href="${up}style.css">
<link rel="alternate" hreflang="ko" href="${up}${alt('ko')}">
<link rel="alternate" hreflang="en" href="${up}${alt('en')}">
<script src="${up}app.js" defer></script>
</head>
<body data-copied="${esc(c.copied)}">
<a class="skip" href="#main">${esc(c.skip)}</a>
<header>
<div class="wrap bar">
<a class="brand" href="${fileName('index')}">${esc(c.siteName)}</a>
<nav aria-label="main">${nav}</nav>
<a class="lang" href="${switchHref}" hreflang="${other}" lang="${other}">${esc(c.switchLabel)}</a>
</div>
</header>
<main id="main" class="wrap">
${body}
</main>
<footer>
<div class="wrap">
<p>${esc(c.footer.disclaimer)}</p>
<p>${esc(c.footer.affiliation)}</p>
<p class="links"><a href="${REPO}">${esc(c.footer.links.repo)}</a> · <a href="${NPM}">${esc(c.footer.links.npm)}</a> · <a href="${REPO}/blob/main/SECURITY.md">${esc(c.footer.links.security)}</a> · <a href="${REPO}/blob/main/LICENSE">${esc(c.footer.links.license)}</a></p>
</div>
</footer>
</body>
</html>
`;
}

const codeBlock = (c: ReturnType<typeof content>, code: string): string =>
  `<div class="code"><pre><code>${esc(code)}</code></pre><button type="button" class="copy" data-copy>${esc(c.copy)}</button></div>`;

function sponsorSection(lang: Lang, sponsors: readonly Sponsor[]): string {
  if (sponsors.length === 0) return '';
  const s = content(lang).sponsor;
  const links = sponsors.map((x) => `<a class="btn alt" href="${esc(x.url)}" rel="noopener noreferrer">${esc(lang === 'ko' ? x.labelKo : x.labelEn)}</a>`).join(' ');
  return `<section>
<h2>${esc(s.title)}</h2>
<p>${esc(s.body)}</p>
<p class="cta">${links}</p>
</section>`;
}

function home(lang: Lang, sponsors: readonly Sponsor[]): string {
  const c = content(lang);
  const h = c.home;
  return `<section class="hero">
<h1>${esc(h.h1)}</h1>
<p class="lead">${esc(h.lead)}</p>
<h2>${esc(h.installTitle)}</h2>
${codeBlock(c, 'npx @eungang/blert init')}
<p class="note">${esc(h.installNote)}</p>
<p class="cta"><a class="btn" href="${fileName('start')}">${esc(h.ctaStart)}</a> <a class="btn alt" href="${fileName('gallery')}">${esc(h.ctaGallery)}</a></p>
</section>
<section class="grid">
${h.features.map((f) => `<article class="card"><h3>${esc(f.title)}</h3><p>${f.body}</p></article>`).join('\n')}
</section>
<section>
<h2>${esc(h.envTitle)}</h2>
<p>${esc(h.envBody)}</p>
</section>
${sponsorSection(lang, sponsors)}`;
}

function start(lang: Lang): string {
  const c = content(lang);
  const s = c.start;
  return `<h1>${esc(s.h1)}</h1>
<p class="lead">${s.lead}</p>
<ol class="steps">
${s.steps.map((st) => `<li><h3>${esc(st.title)}</h3><p>${st.body}</p>${st.code ? codeBlock(c, st.code) : ''}</li>`).join('\n')}
</ol>
<h2>${esc(s.moreTitle)}</h2>
<p>${fill(s.more, { repo: REPO })}</p>`;
}

/** 갤러리 항목의 설치 주소: 저장소의 특정 커밋에 고정한다 */
export const rawUrl = (ref: string, file: string): string => `${RAW}/${ref}/gallery/${file}`;

function presetCard(lang: Lang, ref: string, p: PresetEntry): string {
  const c = content(lang);
  const g = c.gallery;
  const types = Object.entries(p.types).map(([t, n]) => `${esc(g.typeNames[t] ?? t)} ${n}`).join(' · ');
  const cmd = `blert preset install ${rawUrl(ref, p.file)} --sha256 ${p.sha256}`;
  return `<article class="card" id="${esc(p.slug)}">
<h3>${esc(pick(lang, p.name, 'name'))}</h3>
${p.description ? `<p>${esc(pick(lang, p.description, 'description'))}</p>` : ''}
<p class="meta"><span class="tag">${esc(p.needsKey ? g.needsKey : g.noKey)}</span> <span class="tag">${esc(fill(g.rules, { n: String(p.ruleCount) }))}</span> <span class="tag">${types}</span> <span class="tag">${esc(g.reqPreset)}</span></p>
<p class="label">${esc(g.installLabel)}</p>
${codeBlock(c, cmd)}
<p class="label">${esc(g.hashLabel)}</p>
<p class="hash"><code>${esc(p.sha256)}</code></p>
</article>`;
}

/** 미리듣기 버튼의 순서 */
const PLAY_KINDS = ['up', 'down', 'account', 'warn'] as const;

function themeCard(lang: Lang, ref: string, t: ThemeEntry): string {
  const c = content(lang);
  const g = c.gallery;
  const cmd = `blert sound theme ${rawUrl(ref, t.file)}`;
  return `<article class="card" id="${esc(t.slug)}">
<h3>${esc(t.name)}</h3>
<p>${esc(g.themeText[t.slug] ?? '')}</p>
<p class="meta"><span class="tag">${esc(g.soundsLabel)}</span> <span class="tag">${esc(t.license)}</span> <span class="tag">${esc(g.reqTheme)}</span></p>
<p class="label">${esc(g.previewLabel)}</p>
<p class="play">${PLAY_KINDS.map((k) => `<button type="button" class="playbtn" data-play="${esc(prefixTo(lang) + t.sounds[k]!.file)}" aria-label="${esc(fill(g.playAria, { kind: g.kindNames[k] }))}">▶ ${esc(g.kindNames[k])}</button>`).join(' ')}</p>
<p class="label">${esc(g.installLabel)}</p>
${codeBlock(c, cmd)}
<p class="note">${esc(g.themeHashNote)}</p>
</article>`;
}

function gallery(lang: Lang, index: GalleryIndex, ref: string): string {
  const c = content(lang);
  const g = c.gallery;
  return `<h1>${esc(g.h1)}</h1>
<p class="lead">${esc(g.lead)}</p>
<p class="notice">${esc(g.notice)}</p>
<h2>${esc(g.presetsTitle)}</h2>
<div class="grid">
${index.presets.map((p) => presetCard(lang, ref, p)).join('\n')}
</div>
<h2>${esc(g.themesTitle)}</h2>
<p class="note">${esc(g.previewNote)}</p>
<div class="grid">
${index.themes.map((t) => themeCard(lang, ref, t)).join('\n')}
</div>
<h2>${esc(g.own.title)}</h2>
<p>${esc(g.own.intro)}</p>
<ol class="steps">
${g.own.steps.map((st) => `<li><h3>${esc(st.title)}</h3><p>${fill(st.body, { repo: REPO })}</p>${st.code ? codeBlock(c, st.code) : ''}</li>`).join('\n')}
</ol>
<p class="note">${fill(g.own.note, { repo: REPO })}</p>
<h2>${esc(g.verifyTitle)}</h2>
<p>${fill(g.verify, { repo: REPO })}</p>`;
}

function trust(lang: Lang): string {
  const t = content(lang).trust;
  return `<h1>${esc(t.h1)}</h1>
<p class="lead">${esc(t.lead)}</p>
${t.sections.map((s) => `<section><h2>${esc(s.title)}</h2><ul>${s.items.map((i) => `<li>${fill(i, { repo: REPO })}</li>`).join('')}</ul></section>`).join('\n')}`;
}

function privacy(lang: Lang): string {
  const p = content(lang).privacy;
  return `<h1>${esc(p.h1)}</h1>
${p.body.map((x) => `<p>${esc(x)}</p>`).join('\n')}`;
}

export interface SiteFile {
  path: string;
  html: string;
}

/** 모든 페이지를 만든다 (파일에는 쓰지 않는다) */
export function renderSite(index: GalleryIndex, ref: string, sponsors: readonly Sponsor[] = SPONSORS): SiteFile[] {
  const out: SiteFile[] = [];
  for (const lang of ['ko', 'en'] as const) {
    const bodies: Record<PageId, string> = { index: home(lang, sponsors), start: start(lang), gallery: gallery(lang, index, ref), trust: trust(lang), privacy: privacy(lang) };
    for (const id of PAGES) out.push({ path: `${lang === 'en' ? 'en/' : ''}${fileName(id)}`, html: layout(lang, id, bodies[id]) });
  }
  return out;
}

export async function buildSite(outDir: string, ref: string): Promise<string[]> {
  const { index, problems } = await buildIndex(join(ROOT, 'gallery'));
  if (problems.length > 0) throw new Error(`갤러리 검사에 실패했습니다:\n${problems.join('\n')}`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, 'en'), { recursive: true });
  const written: string[] = [];
  for (const f of renderSite(index, ref)) {
    await writeFile(join(outDir, f.path), f.html);
    written.push(f.path);
  }
  // 미리듣기용 소리 파일: 같은 사이트 안의 파일만 재생한다
  for (const t of index.themes) {
    for (const sound of Object.values(t.sounds)) {
      await mkdir(dirname(join(outDir, sound.file)), { recursive: true });
      await copyFile(join(ROOT, 'gallery', sound.file), join(outDir, sound.file));
      written.push(sound.file);
    }
  }
  for (const asset of ['style.css', 'app.js']) {
    await copyFile(join(HERE, asset), join(outDir, asset));
    written.push(asset);
  }
  await writeFile(join(outDir, '.nojekyll'), '');
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ref = process.env.GALLERY_REF ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const files = await buildSite(join(HERE, 'out'), ref);
  console.log(`사이트 ${files.length}개 파일을 site/out/에 만들었습니다 (갤러리 커밋: ${ref.slice(0, 7)})`);
}
