import { beforeEach } from 'vitest';
import { setLanguage } from '../src/i18n/index.js';

delete process.env.BLERT_LANG;
// init의 첫 질문은 빈 입력이면 OS 로캘의 언어를 따른다. 영어 로캘인 CI(ubuntu 등)에서도 같은 결과가 나오도록 로캘도 한국어로 고정한다
process.env.LC_ALL = 'ko_KR.UTF-8';
process.env.LC_MESSAGES = 'ko_KR.UTF-8';
process.env.LANG = 'ko_KR.UTF-8';
setLanguage('ko');
// 영어 테스트가 언어를 바꾸고 되돌리지 못해도 다음 테스트가 한국어로 시작한다
beforeEach(() => setLanguage('ko'));
