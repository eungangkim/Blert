import type { Alert } from '../shared/types.js';
import { hasMessage, t } from '../i18n/index.js';
import { render, renderParams } from './render.js';

/** 음성 문장 한도 (D-115) */
export const SPEECH_MAX_CHARS = 100;

// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

/** 재생기에 넘기기 전에 제어 문자를 지우고 공백을 정리해 길이를 제한한다 (D-115, D-117) */
export function sanitizeSpeech(text: string): string {
  const clean = text.replace(CONTROL, ' ').replace(/\s{2,}/g, ' ').trim();
  return clean.length > SPEECH_MAX_CHARS ? clean.slice(0, SPEECH_MAX_CHARS).trimEnd() : clean;
}

/**
 * 알림을 읽을 짧은 문장으로 바꾼다 (D-113). `alert.<이름>.title`에 대응하는 `speech.<이름>` 키가 있으면 그 문장을 쓰고,
 * 없으면 화면 제목을 읽는다. 제목에 들어갈 수 있는 값(심볼 등)은 문장 안에서 제어 문자를 지운다.
 */
export function speechText(alert: Alert): string {
  const key = alert.titleKey.replace(/^alert\./, 'speech.').replace(/\.title$/, '');
  const text = hasMessage(key) ? t(key, renderParams(alert)) : render(alert).title;
  return sanitizeSpeech(text);
}
