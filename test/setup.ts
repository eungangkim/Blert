import { beforeEach } from 'vitest';
import { setLanguage } from '../src/i18n/index.js';

delete process.env.BLERT_LANG;
setLanguage('ko');
// 영어 테스트가 언어를 바꾸고 되돌리지 못해도 다음 테스트가 한국어로 시작한다
beforeEach(() => setLanguage('ko'));
