import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, serializeIndex } from './lib.js';

/**
 * 갤러리 목록(index.json)을 만든다 (D-85, D-133).
 *   npm run gallery:build   index.json을 다시 쓴다
 *   npm run gallery:check   검사만 하고, 문제가 있거나 index.json이 최신이 아니면 실패한다
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const { index, problems } = await buildIndex(root);
if (problems.length > 0) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
const next = serializeIndex(index);
if (check) {
  const current = await readFile(join(root, 'index.json'), 'utf8').catch(() => '');
  if (current !== next) {
    console.error('✗ index.json이 최신이 아닙니다. `npm run gallery:build`를 실행하세요.');
    process.exit(1);
  }
  console.log(`갤러리 확인 완료: 프리셋 ${index.presets.length}개, 소리 테마 ${index.themes.length}개`);
} else {
  await writeFile(join(root, 'index.json'), next);
  console.log(`index.json 갱신: 프리셋 ${index.presets.length}개, 소리 테마 ${index.themes.length}개`);
}
