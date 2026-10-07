# blert

바이낸스 현물·선물 알림을 명령어로 설정하고, **내 PC**에서 데스크톱 알림과 소리로 받는 로컬 CLI 도구입니다.
서버가 없고, API 키와 설정은 이 PC 밖으로 나가지 않습니다. 네트워크 요청은 바이낸스 서버로만 가고, **외부 알림 채널(텔레그램)을 내가 직접 켠 경우에만** 알림 문구가 그 서비스로 전달됩니다(기본은 꺼짐).

> 투자 조언이 아니며, 알림 누락·지연으로 생긴 손실에 책임지지 않습니다.

## 설치

Node.js 24 이상이 필요합니다.

```bash
npx @eungang/blert init        # 바로 시작 (초기 설정)
npm install -g @eungang/blert@1.0.0   # 전역 설치. 공급망 보안을 위해 버전을 고정해서 설치하세요 (설치 뒤 명령어는 `blert`)
```

### 지원 환경

| 환경 | 상태 |
| --- | --- |
| **Windows 11** | **검증됨** — 알림·소리, 데몬, 로그인 시 자동 시작, 계정 알림, 텔레그램 채널(가격 알림을 폰으로 수신)을 실제로 확인했습니다 |
| macOS, Linux | 자동 테스트(CI)만 통과했습니다. 데스크톱 알림, 소리, 데몬 분리 실행은 **아직 직접 확인하지 못했습니다**. 로그인 시 자동 시작은 아직 지원하지 않습니다 |

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

## 계정 알림 (읽기 전용 키)

내 주문 체결과 잔고 변동도 알려 받을 수 있습니다. **읽기 전용 Ed25519 키**만 쓸 수 있고, 키는 파일이 아니라 **OS 키체인**에만 저장됩니다.

```bash
blert key add                     # API 키와 개인키(PEM) 파일 경로를 입력 → 키체인에 저장
blert add fill all                # 모든 체결 알림
blert add balance USDT 5%         # USDT 잔고가 마지막 알림 대비 5% 이상 변하면 알림 (쿨다운 10분)
blert key check                   # 저장된 키의 권한을 다시 확인
blert key remove                  # 키체인에서 키 삭제
```

- **읽기 권한만** 켠 키를 만드세요. 거래·출금·마진·선물 권한이 하나라도 켜져 있으면 저장도 실행도 거부합니다.
- 바이낸스 API 관리에서 **허용 IP 제한**을 켜는 것을 권장합니다. 없으면 실행할 때마다 경고합니다.
- HMAC 키와 RSA 키는 쓸 수 없습니다. Ed25519 키쌍을 만들어 공개키를 바이낸스에 등록하세요: `openssl genpkey -algorithm ED25519 -out private_key.pem`
- 키 문제(권한 변경 등)가 생기면 **계정 알림만 멈추고 공개 알림은 계속**됩니다. 멈춘 이유는 알림으로 알려 줍니다.
- OS 키체인이 없는 환경(일부 Linux)에서는 계정 알림을 쓸 수 없고 공개 알림만 동작합니다. 키를 파일이나 환경변수로 대신 저장하지 않습니다.

### 선물 계정 알림

```bash
blert add liq f:BTC 5%            # 마크 가격이 청산가에서 5% 이내로 가까워지면 알림 (쿨다운 5분)
blert add fill f:BTC              # BTC 선물 주문 체결 알림
```

- 같은 읽기 전용 키로 선물 포지션과 청산가를 읽습니다. **선물 권한(`enableFutures`)이 켜진 키는 선물 주문도 할 수 있으므로 거부합니다.**
- 청산가는 15초마다, 그리고 체결·계정 변동 이벤트가 올 때 다시 읽습니다. 시작할 때 이미 기준 안이면 바로 알립니다.
- 선물 체결은 심볼을 지정해야 합니다(`f:all` 없음). 한 심볼에 롱·숏이 함께 있으면 청산가에 더 가까운 쪽 기준입니다.
- 선물 사용자 데이터 스트림은 바이낸스가 listenKey 방식만 제공해서, 선물에 한해 listenKey를 씁니다(현물은 쓰지 않습니다).

## 백그라운드로 실행 (데몬)

터미널을 닫아도 감시를 계속하려면 `run` 대신 `start`를 씁니다.

```bash
blert start          # 감시를 백그라운드로 시작 (준비될 때까지 기다렸다가 결과를 알려줍니다)
blert status         # 실행 여부, 규칙 수, 연결 상태, 최근 감시 중단 구간
blert logs           # 로그 마지막 50줄 (-n 20: 줄 수, -f: 새 줄을 이어서 보기)
blert stop           # 상태를 저장하고 정상 종료
```

- 데몬이 실행 중일 때 `blert add`, `del`, `pause`, `resume`으로 규칙을 바꾸면 **재시작 없이** 반영됩니다. 포그라운드 `blert run`도 같습니다.
- 알림과 소리는 `run`과 같게 나옵니다. 화면 출력은 없고 알림 전체가 `blert logs`에 남습니다.
- 데몬이 강제 종료되거나 보안 프로그램에 의해 종료되면, 이후 어떤 명령이든 실행할 때 한 줄로 경고합니다. `blert start`로 다시 시작하면 멈춰 있던 구간이 기록됩니다.
- `blert run`과 `blert start`는 동시에 실행할 수 없습니다. 이미 실행 중이면 `blert status`를 안내합니다.
- 컴퓨터를 재부팅하면 데몬도 꺼집니다(부팅 시 자동 시작은 이후 버전의 기능입니다).

### 로그인할 때 자동으로 시작 (Windows)

```bash
blert service install     # 로그인한 뒤 30초 뒤에 데몬이 자동으로 켜지도록 등록 (확인 질문이 나옵니다)
blert service uninstall   # 해제 (실행 중인 데몬은 그대로 둡니다)
blert status              # 마지막 줄에 자동 시작 등록 여부가 나옵니다
```

- Windows **작업 스케줄러**에 현재 사용자의 로그온 작업(`blert`)을 만듭니다. **관리자 권한이 필요하지 않습니다.**
- 알림·소리·OS 키체인은 로그인한 사용자 세션이 있어야 해서, 컴퓨터를 켠 직후가 아니라 **로그인할 때** 시작합니다.
- 로그인 직후 네트워크가 아직 없어도 데몬은 끝나지 않고 계속 재시도하며, 연결되면 알려 줍니다. 이미 실행 중이면 조용히 넘어갑니다.
- 등록할 때 현재 실행 중인 `node`와 `blert`의 경로를 기록합니다. 업데이트하거나 폴더를 옮겨 경로가 바뀌면 `blert status`가 알려 주니 `blert service install`을 다시 실행하세요. `npx`로 실행한 임시 경로에서는 등록할 수 없으니 전역 설치(`npm install -g @eungang/blert`)를 쓰세요.
- macOS와 Linux는 아직 지원하지 않습니다(`blert start`를 직접 실행하세요).

## 폰으로 알림 받기 (텔레그램, 선택 기능)

외부 채널은 **기본으로 꺼져 있고**, 직접 등록해야만 켜집니다.

```bash
blert channel add telegram     # 안내를 읽고 동의 → 봇 토큰 입력 → 봇에 메시지 보내기 → 시험 메시지
blert channel test             # 시험 메시지 다시 보내기
blert channel account off      # 등록은 그대로 두고 계정 알림만 폰으로 보내지 않기 (on: 다시 켜기)
blert channel remove           # 해제 (토큰도 키체인에서 삭제)
```

1. 텔레그램에서 `@BotFather`에게 `/newbot`을 보내 봇을 만들고 **봇 토큰**을 받습니다.
2. `blert channel add telegram`을 실행해 토큰을 입력하고, 안내에 따라 **새 봇에게 아무 메시지나 보냅니다**(예: `/start`). blert가 대화를 찾아 연결합니다.
3. 기본으로 **공개 시장 알림(가격·변동률·거래량·펀딩비)과 감시 중단 경고**만 보냅니다. **체결·잔고·청산가 같은 계정 알림은 등록할 때 허용한 경우에만** 보냅니다. 등록한 뒤에는 `blert channel account on|off`로 바꿉니다(켤 때는 다시 동의를 받습니다. 토큰과 대화 ID는 그대로입니다).
4. API 키와 개인키는 어떤 경우에도 보내지 않습니다. 봇 토큰은 OS 키체인에만 저장하고 설정 파일에는 남기지 않습니다. 알림 문구는 텔레그램 서버를 거치며 거기에 남을 수 있습니다.
5. 전송이 실패해도(오프라인 등) 데스크톱 알림과 소리는 그대로 동작합니다. 실패한 알림은 나중에 다시 보내지 않습니다.

이 기능을 켠 경우에만 `api.telegram.org`로 요청이 나갑니다. 해제하면 다시 바이낸스로만 요청합니다.

## 저장 위치

Windows `%APPDATA%\blert\`, macOS·Linux `~/.config/blert/` — `config.json`, `rules.json`, `state.json`, `logs/`.
로그는 7일 또는 10MB까지 보관합니다.

## 문제 해결

- **알림이 안 보입니다** — `blert test`를 실행하고 안내를 따르세요. Windows는 설정 > 시스템 > 알림과 집중 지원(방해 금지)을 확인하세요.
- **`blert run`이 소리 없이 꺼집니다** — 일부 보안 프로그램(예: Avast 행동 감시)은 PowerShell을 띄우는 프로세스를 종료시킬 수 있습니다. blert는 이를 피하는 방식으로 알림을 띄우지만, 그래도 꺼지면 blert(`node.exe`)를 보안 프로그램의 예외 목록에 추가하세요.
- **"이미 blert 감시가 실행 중입니다"라고 나옵니다** — 다른 터미널에서 `blert run`이 켜져 있습니다. 그쪽에서 Ctrl+C로 종료하세요. 이미 꺼졌는데도 나온다면 1분 뒤 다시 시도하세요(생존 신호가 끊기면 자동으로 정리됩니다).
- **연결할 수 없다고 나옵니다** — `stream.binance.com`, `fstream.binance.com`, `api.binance.com`, `fapi.binance.com`(계정 알림은 `ws-api.binance.com`)에 접속할 수 있어야 합니다. 텔레그램 채널을 켰다면 `api.telegram.org`도 필요합니다.
- **텔레그램 알림이 안 옵니다** — `blert channel test`로 확인하세요. 토큰이나 대화 ID가 틀리면 `blert channel add telegram`을 다시 실행하세요. 계정 알림(체결 등)은 등록할 때 허용하지 않으면 보내지 않습니다.

## 라이선스

MIT ([LICENSE](LICENSE)). 번들 음원(`assets/sounds/`)은 CC0이며 출처는 `assets/sounds/LICENSES.md`에 있습니다.
