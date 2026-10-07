import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : files(p, ext);
    return ext.test(name) ? [p] : [];
  });
}

describe('구조 규칙 (B2 모듈 경계)', () => {
  // B2 모듈 표의 "의존 가능" 열. shared는 모든 모듈이 쓸 수 있는 공통 모듈이다.
  const ALLOWED: Record<string, string[]> = {
    cli: ['store', 'presets', 'security', 'i18n'],
    presets: ['store'],
    engine: ['store'],
    binance: ['security'],
    security: [],
    notify: ['i18n'],
    store: [],
    i18n: [],
    shared: [],
    runtime: ['cli', 'presets', 'engine', 'binance', 'security', 'notify', 'store', 'runtime', 'i18n'],
  };

  it('각 모듈은 B2 표의 "의존 가능" 열에 있는 모듈만 import한다', () => {
    const violations: string[] = [];
    for (const file of files(SRC, /\.ts$/)) {
      const rel = relative(SRC, file);
      const mod = rel.split(sep)[0]!;
      if (!(mod in ALLOWED)) continue; // src/index.ts(진입점)는 조립 지점이라 제외
      const code = readFileSync(file, 'utf8');
      for (const m of code.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/g)) {
        const target = relative(SRC, resolve(dirname(file), m[1]!)).split(sep)[0]!;
        if (target === mod || target === 'shared' || target.endsWith('.json')) continue;
        if (!ALLOWED[mod]!.includes(target)) violations.push(`${rel} → ${target}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('binance·engine·notify는 서로 직접 import하지 않는다 (이벤트 버스로만 통신)', () => {
    const banned: [string, string][] = [['binance', 'engine'], ['binance', 'notify'], ['engine', 'binance'], ['engine', 'notify'], ['notify', 'binance'], ['notify', 'engine']];
    for (const [from, to] of banned) {
      for (const file of files(join(SRC, from), /\.ts$/)) {
        expect(readFileSync(file, 'utf8'), `${from} → ${to}: ${file}`).not.toMatch(new RegExp(`(?:from|import)\\s*\\(?\\s*'\\.\\./${to}/`));
      }
    }
  });

  it('로거를 거치지 않는 console 출력이 없다', () => {
    const offenders = files(SRC, /\.ts$/).filter((f) => /\bconsole\.(log|error|warn|info|debug)\b/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('src 코드가 바이낸스 외 도메인 주소를 담고 있지 않다 (NFR-SEC-02)', () => {
    const hosts = new Set<string>();
    for (const f of files(SRC, /\.ts$/)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1]!.toLowerCase());
    }
    // 주석의 문서 링크(developers.binance.com, kenney.nl, learn.microsoft.com 등)와 작업 정의 XML의 네임스페이스 식별자(schemas.microsoft.com)는
    // 네트워크 요청이 아니다. 아래 목록은 실제로 요청을 보내는 주소만 남긴다.
    const runtimeHosts = [...hosts].filter((h) => !/^(developers\.binance\.com|kenney\.nl|creativecommons\.org|github\.com|learn\.microsoft\.com|schemas\.microsoft\.com|core\.telegram\.org)$/.test(h));
    // 실서버 5곳, BLERT_NETWORK=testnet 에서만 허용되는 테스트넷 4곳(현물 2, 선물 데모 2, shared/network.ts),
    // 그리고 사용자가 외부 채널(텔레그램)을 등록했을 때만 쓰는 api.telegram.org (D-69, notify/telegram.ts)
    expect(runtimeHosts.sort()).toEqual([
      'api.binance.com', 'api.telegram.org', 'demo-fapi.binance.com', 'demo-fstream.binance.com', 'fapi.binance.com', 'fstream.binance.com', 'stream.binance.com', 'testnet.binance.vision', 'ws-api.binance.com', 'ws-api.testnet.binance.vision',
    ]);
  });
});

describe('패키지 규칙 (NFR-SEC-03, NFR-COMP-02)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    bin: Record<string, string>;
    engines: { node: string };
    files: string[];
  };

  it('NFR-SEC-03 런타임 의존성은 10개 이하이고 모든 의존성 버전을 고정했다(^, ~ 없음)', () => {
    const runtime = pkg.dependencies ?? {};
    expect(Object.keys(runtime).length).toBeLessThanOrEqual(10);
    for (const [name, version] of Object.entries({ ...runtime, ...pkg.devDependencies })) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('개발 의존성은 CLAUDE.md가 허용한 목록 안에 있다', () => {
    expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual(['@types/node', 'tsx', 'typescript', 'vitest']);
  });

  it('bin은 blert 하나이고 dist/index.js를 가리키며, 음원 폴더가 패키지에 포함된다', () => {
    expect(pkg.bin).toEqual({ blert: 'dist/index.js' });
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'assets']));
    expect(pkg.engines.node).toBe('>=24');
    expect(readFileSync(join(SRC, 'index.ts'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });
});

describe('배포 점검 (NFR-SEC-03, NFR-SEC-04, D-75)', () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
  const pkg = JSON.parse(read('package.json')) as { version: string; files: string[]; dependencies?: Record<string, string>; repository?: { url?: string }; license?: string };

  it('AC-70 패키지에는 dist와 assets만 들어가고(소스·테스트·문서·키 파일 없음), 소스맵을 만들지 않는다', () => {
    expect(pkg.files.slice().sort()).toEqual(['assets', 'dist']);
    const build = read('tsconfig.build.json') + read('tsconfig.json');
    expect(build).not.toMatch(/sourceMap|declarationMap|inlineSources/);
    expect(read('.gitignore')).toMatch(/^dist\/$/m);
  });

  it('AC-70 버전은 x.y.z 형식이고 저장소 주소와 라이선스가 있으며 LICENSE 파일이 있다', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.repository?.url).toMatch(/github\.com\/[^/]+\/[^/]+\.git$/);
    expect(pkg.license).toBe('MIT');
    expect(read('LICENSE')).toContain('MIT License');
  });

  it('AC-70 배포 워크플로는 태그와 package.json 버전을 비교하고, provenance로 배포하며, 시크릿은 배포 단계에서만 쓴다', () => {
    const y = read('.github/workflows/publish.yml');
    expect(y).toContain('GITHUB_REF_NAME');
    expect(y).toContain("require('./package.json').version");
    expect(y).toContain('npm publish --provenance --access public');
    expect(y).toMatch(/id-token: write/);
    expect(y).toMatch(/tags: \['v\*'\]/);
    expect([...y.matchAll(/secrets\.NPM_TOKEN/g)]).toHaveLength(1);
    const publishStep = y.indexOf('run: npm publish');
    expect(y.indexOf('secrets.NPM_TOKEN')).toBeGreaterThan(publishStep);
    expect(y.indexOf('run: npm test')).toBeLessThan(publishStep);
    expect(y.indexOf('GITHUB_REF_NAME')).toBeLessThan(publishStep);
  });

  it('AC-70 모든 워크플로의 액션은 40자리 커밋 SHA로 고정돼 있다 (태그로 참조하지 않는다)', () => {
    for (const f of ['publish.yml', 'test.yml']) {
      const uses = [...read(`.github/workflows/${f}`).matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
      expect(uses.length, f).toBeGreaterThan(0);
      for (const u of uses) expect(u, `${f}: ${u}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });
});

describe('수용 기준 커버리지 (CLAUDE.md 테스트 규칙)', () => {
  const names = files(join(ROOT, 'test'), /\.test\.ts$/).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\bit\('(AC-\d{2})[ ,]/g)].map((m) => m[1]!));

  it('AC-01 ~ AC-24와 AC-26 ~ AC-70은 이름이 해당 ID로 시작하는 자동 테스트가 하나 이상 있다 (AC-25, AC-51, AC-60, AC-71, AC-72는 수동)', () => {
    // 아직 구현하지 않은 항목. 구현하면 여기서 지운다 (마지막 단계에서 비어 있어야 한다).
    const PENDING: string[] = [];
    const ids = Array.from({ length: 72 }, (_, i) => i + 1)
      .filter((n) => ![25, 51, 60, 71, 72].includes(n))
      .map((n) => `AC-${String(n).padStart(2, '0')}`)
      .filter((id) => !PENDING.includes(id));
    expect(ids.filter((id) => !names.includes(id))).toEqual([]);
  });

  it('현재 목표(v1.0)를 넘는 수용 기준(AC-73 이상) 테스트는 없다', () => {
    expect(names.filter((n) => Number(n.slice(3)) > 72)).toEqual([]);
  });
});
