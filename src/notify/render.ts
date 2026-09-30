import type { Alert } from '../shared/types.js';
import { t } from '../i18n/index.js';

const pad = (n: number) => String(n).padStart(2, '0');

/** 사용자 PC의 지역 시각 HH:MM */
export function clockHM(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function clockHMS(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 알림을 제목·본문 문장으로 바꾼다. 본문 키는 titleKey의 `.title`을 `.body`로 바꾼 것이다.
 * params.market(spot/futures)은 여기서 번역한다 (engine은 i18n에 의존하지 않는다, B2).
 */
export function render(alert: Alert): { title: string; body: string } {
  const params = { ...alert.params };
  if (params.market === 'spot' || params.market === 'futures') params.market = t(`market.${params.market}`);
  const bodyKey = alert.titleKey.replace(/\.title$/, '.body');
  const body = bodyKey === alert.titleKey ? '' : t(bodyKey, params);
  return { title: t(alert.titleKey, params), body: body === bodyKey ? '' : body };
}
