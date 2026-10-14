/**
 * 후원 링크. 비어 있으면 사이트에 후원 구역이 나오지 않는다.
 * 계정을 만든 뒤에만 채운다. https 주소만, 추적용 매개변수(?)는 붙이지 않는다 (D-87).
 * 후원은 기능·지원 우선권과 무관하다.
 */
export interface Sponsor {
  labelKo: string;
  labelEn: string;
  url: string;
}

export const SPONSORS: readonly Sponsor[] = [
  { labelKo: 'Buy Me a Coffee로 후원', labelEn: 'Support on Buy Me a Coffee', url: 'https://buymeacoffee.com/kimeungang' },
];
