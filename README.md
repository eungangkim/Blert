# blert

바이낸스 현물·선물 알림을 명령어로 설정하고, **내 PC**에서 데스크톱 알림과 소리로 받는 로컬 CLI 도구입니다.
서버가 없고, 설정과 데이터는 이 PC 밖으로 나가지 않습니다. 네트워크 요청은 바이낸스 공개 시세 서버로만 갑니다.

> 투자 조언이 아니며, 알림 누락·지연으로 생긴 손실에 책임지지 않습니다.

## 설치

Node.js 24 이상이 필요합니다.

```bash
npx blert init                 # 바로 시작 (초기 설정)
npm install -g blert@0.1.0     # 전역 설치. 공급망 보안을 위해 버전을 고정해서 설치하세요
```

## 빠른 시작

```bash
blert init                              # 고지 동의, 소리 설정, 프리셋 선택
blert preset install major-swing        # BTC·ETH·SOL 1시간 5% 변동
blert add price BTC above 70000         # BTC가 70,000을 넘는 순간 알림 (1회)
blert add price BTC below 65000         # 65,000 아래로 내려가는 순간 알림 (1회)
blert add change ETH 5% 1h down         # ETH가 1시간 동안 5% 하락하면 알림
blert add volume SOL x4 5m/1h           # SOL 5분 거래대금이 1시간 평균의 4배
blert add funding f:BTC above 0.05%     # 선물 BTC 펀딩비가 0.05% 초과
blert list                              # 등록된 알림 보기
blert run                               # 감시 시작 (종료: Ctrl+C)
```

선물은 심볼 앞에 `f:`를 붙입니다(`f:BTC`). `BTC`는 `BTCUSDT`로 자동 보완됩니다.

## 알림이 오는 시점

- **가격·펀딩비**: 기준을 **넘는 순간**에 알립니다. `above`는 위로 넘을 때, `below`는 아래로 내려갈 때입니다.
  `blert run`을 켰을 때 이미 기준을 넘은 상태면 알리지 않고, 반대편으로 갔다가 다시 넘을 때 알립니다.
- **변동률·거래량**: 현재 수준을 봅니다. 조건이 맞으면 알리고, 같은 알림이 계속 오지 않도록 쿨다운(변동률 30분, 거래량 15분)을 둡니다.
- 알림이 짧은 시간에 여러 건 몰리면 "알림 N건" 하나로 묶어 보여줍니다. 경고(연결 끊김 등)는 묶지 않습니다.
- `blert run`은 동의(`blert init`)를 마친 뒤에만 시작하고, 이미 실행 중이면 두 번째 실행을 거부합니다.
- 감시가 비정상적으로 꺼졌다면(강제 종료, 보안 프로그램, 정전 등) 다음에 `blert run`을 켤 때 "감시 중단 구간"으로 알려 줍니다.

## 명령

| 명령 | 설명 |
| --- | --- |
| `blert init` | 초기 설정 |
| `blert add <유형> ...` | 알림 추가: `price`, `change`, `volume`, `funding` |
| `blert list [--all]` | 알림 목록 (`--all`: 발동이 끝난 알림 포함) |
| `blert del` `pause` `resume <ID\|all>` | 삭제·일시정지·재개 |
| `blert preset list\|install\|remove` | 프리셋: `major-swing`, `volume-burst`, `futures-heat` |
| `blert run` | 감시 시작 |
| `blert test [유형]` | 시험 알림 |
| `blert sound on\|off\|test` | 소리 켜기·끄기·시험 |

모든 명령에 `--help`가 있고, 고급 옵션은 `blert --help --advanced`에서 볼 수 있습니다.

## 저장 위치

Windows `%APPDATA%\blert\`, macOS·Linux `~/.config/blert/` — `config.json`, `rules.json`, `state.json`, `logs/`.
로그는 7일 또는 10MB까지 보관합니다.

## 문제 해결

- **알림이 안 보입니다** — `blert test`를 실행하고 안내를 따르세요. Windows는 설정 > 시스템 > 알림과 집중 지원(방해 금지)을 확인하세요.
- **`blert run`이 소리 없이 꺼집니다** — 일부 보안 프로그램(예: Avast 행동 감시)은 PowerShell을 띄우는 프로세스를 종료시킬 수 있습니다. blert는 이를 피하는 방식으로 알림을 띄우지만, 그래도 꺼지면 blert(`node.exe`)를 보안 프로그램의 예외 목록에 추가하세요.
- **"이미 blert 감시가 실행 중입니다"라고 나옵니다** — 다른 터미널에서 `blert run`이 켜져 있습니다. 그쪽에서 Ctrl+C로 종료하세요. 이미 꺼졌는데도 나온다면 1분 뒤 다시 시도하세요(생존 신호가 끊기면 자동으로 정리됩니다).
- **연결할 수 없다고 나옵니다** — `stream.binance.com`, `fstream.binance.com`, `api.binance.com`, `fapi.binance.com`에 접속할 수 있어야 합니다.

## 라이선스

MIT ([LICENSE](LICENSE)). 번들 음원(`assets/sounds/`)은 CC0이며 출처는 `assets/sounds/LICENSES.md`에 있습니다.
