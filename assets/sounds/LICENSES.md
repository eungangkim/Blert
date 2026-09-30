# 번들 음원 라이선스 (NFR-LEGAL-02, D-11)

모든 음원은 **CC0 1.0 (Public Domain Dedication)** 입니다. 출처 표기 의무는 없지만 기록해 둡니다.
CC0가 아니거나 출처가 불분명한 음원은 추가하지 않습니다.

- 팩: **Interface Sounds 1.0** — Kenney (https://kenney.nl)
- 팩 페이지: https://kenney.nl/assets/interface-sounds
- 내려받은 파일: https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip
- 라이선스: Creative Commons Zero, CC0 — https://creativecommons.org/publicdomain/zero/1.0/
  (팩 안의 `License.txt`와 팩 페이지에서 확인, 2026-09-30)

## 파일별 출처

| 파일 | 원본 (팩 내 `Audio/`) | 가공 | 길이 | 크기 | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `up.wav` | `maximize_009.ogg` | 형식 변환 | 0.22초 | 9.6KB | `a7d8f56639093bd9f45a206e0163b196522d476ed204a306400cfe076c3aab4b` |
| `down.wav` | `minimize_008.ogg` | 형식 변환 | 0.23초 | 9.7KB | `aed16b935d6ae2aa1c91591e18e40a2553328cf4068345770decd198ace0e408` |
| `account.wav` | `glass_001.ogg` | 형식 변환 | 0.28초 | 11.9KB | `eaa21add5a2b89dfbba5ee64b25ae81c05ab33a5654ddfa3ff7c25a596a5d3a4` |
| `warn.wav` | `error_007.ogg` | 형식 변환 + 3회 반복(사이 0.12초 무음) | 0.82초 | 35.2KB | `4f2829d7f8555320d8d2eb80f5a5f1d0d6b88822243d415832880dd98bc6a30a` |

## 가공 방법

- 형식 변환: `ffmpeg -i <원본>.ogg -ac 1 -ar 22050 -sample_fmt s16 <이름>.wav` (모노, 22.05kHz, 16비트 PCM)
  - WAV는 macOS·Windows·Linux 기본 재생 도구가 모두 지원해 추가 의존성이 필요 없다 (B7).
  - 길이 1.5초 이하, 파일당 100KB 이하 기준을 지키기 위해 22.05kHz 모노로 낮췄다.
- `warn.wav`: 변환한 `error_007` 을 0.12초 무음을 사이에 두고 3번 이어 붙였다 (반복되는 경고음, B7 D-29).

## 선정 근거

소리를 직접 들을 수 없는 환경에서 골랐으므로 주파수 변화로 판단했다. 최종 청취 확인은 AC-18 수동 절차에서 한다.

- `up`: 1144 → 1688Hz로 올라가는 짧은 음
- `down`: 404 → 275Hz로 내려가는 낮은 음
- `account`: 약 1.9kHz의 지속되는 벨 계열 음
- `warn`: 767Hz 버저음의 반복 (나머지 셋과 구분)

음원을 바꿀 때는 이 표와 해시를 함께 갱신한다.
