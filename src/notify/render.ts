import type { Alert } from '../shared/types.js';
import { t } from '../i18n/index.js';

const pad = (n: number) => String(n).padStart(2, '0');

/** 사용자 PC의 지역 시각 HH:MM */
export function clockHM(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 중단 구간 표기. 같은 날이면 HH:MM, 날짜를 넘으면 M/D HH:MM으로 날짜를 함께 보여준다 */
export function gapTimes(fromMs: number, toMs: number): { from: string; to: string } {
  if (new Date(fromMs).toDateString() === new Date(toMs).toDateString()) return { from: clockHM(fromMs), to: clockHM(toMs) };
  const withDate = (ms: number) => `${new Date(ms).getMonth() + 1}/${new Date(ms).getDate()} ${clockHM(ms)}`;
  return { from: withDate(fromMs), to: withDate(toMs) };
}

export function clockHMS(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const UNITS = [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const;

/** 정확히 나누어떨어지는 가장 큰 단위로 한글 표기한다. 예: 3600000 → 1시간, 300000 → 5분 */
export function durationText(ms: number): string {
  for (const [unit, size] of UNITS) if (ms % size === 0) return `${ms / size}${t(`unit.${unit}`)}`;
  return `${Math.round(ms / 1000)}${t('unit.s')}`;
}

/**
 * 알림을 제목·본문 문장으로 바꾼다. 본문 키는 titleKey의 `.title`을 `.body`로 바꾼 것이다.
 * params.market(spot/futures)은 여기서 번역한다 (engine은 i18n에 의존하지 않는다, B2).
 */
export function render(alert: Alert): { title: string; body: string } {
  const params = { ...alert.params };
  // 이름이 Ms로 끝나는 숫자 파라미터(windowMs 등)는 기간(ms)이다. 한글 단위로 바꿔 같은 이름에서 Ms를 뺀 키로 쓴다.
  for (const [k, v] of Object.entries(alert.params)) {
    if (k.endsWith('Ms') && typeof v === 'number') params[k.slice(0, -2)] = durationText(v);
  }
  if (params.market === 'spot' || params.market === 'futures') params.market = t(`market.${params.market}`);
  if (params.side === 'BUY' || params.side === 'SELL') params.side = t(`side.${params.side}`);
  const bodyKey = alert.titleKey.replace(/\.title$/, '.body');
  const body = bodyKey === alert.titleKey ? '' : t(bodyKey, params);
  // 견적 통화를 알 수 없는 쌍은 quote가 비어 공백이 겹친다
  return { title: t(alert.titleKey, params).replace(/ {2,}/g, ' ').trim(), body: body === bodyKey ? '' : body.replace(/ {2,}/g, ' ').trim() };
}
