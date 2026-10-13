# 보안 정책 / Security Policy

## 취약점 신고 / Reporting a vulnerability

보안 문제를 발견하면 **공개 이슈로 올리지 말고** GitHub의 비공개 신고를 이용해 주세요.

1. 이 저장소의 **Security** 탭을 엽니다.
2. **Report a vulnerability**를 누릅니다.
3. 재현 방법, 영향 범위, 사용한 blert 버전을 적습니다.

If you find a security issue, please do **not** open a public issue. Use GitHub's private reporting: open the **Security** tab of this repository, choose **Report a vulnerability**, and include the steps to reproduce, the impact, and your blert version.

## 신고에 넣지 말아야 할 것 / What not to include

API 키, 시크릿, 개인키, 계정 정보는 신고에 붙이지 마세요. 필요하면 마스킹한 형태로 설명해 주세요.
Never paste API keys, secrets, private keys, or account details. Describe them in masked form.

## 처리 방침 / How reports are handled

- 모든 신고에 답한다고 약속하지는 않지만, 확인된 취약점은 우선해서 고칩니다.
- 아직 고치지 않은 취약점의 세부 내용은 수정판을 낸 뒤에 공개합니다. 설계와 보안 관련 자료는 그 밖에는 모두 공개합니다.
- We cannot promise to reply to every report, but confirmed vulnerabilities are fixed first. Details of an unfixed vulnerability are published after the fix is released.

## 지원 버전 / Supported versions

최신 버전만 지원합니다. 최신 버전을 쓰는 것을 권합니다.
Only the latest version is supported.

## 이 도구의 보안 원칙 / Security principles

- 읽기 전용 API 키만 받습니다. 거래·출금 권한이 켜진 키는 거부합니다.
- 키는 OS 키체인에만 저장하고 파일·로그에 남기지 않습니다.
- 사용 정보를 어디로도 보내지 않습니다(텔레메트리 없음).
- Read-only API keys only; keys with trading or withdrawal permission are rejected. Keys live in the OS keychain only. No telemetry.
