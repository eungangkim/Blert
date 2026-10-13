# 갤러리 원본 / Gallery source

블러트 웹사이트의 프리셋·소리 갤러리가 이 폴더의 파일을 원본으로 씁니다 (D-85).
The website's preset and sound gallery is built from the files in this folder.

- 처음에는 작성자가 직접 큐레이션한 항목만 올립니다. 사용자 제출은 받지 않습니다 (D-133).
- Only curated items are published for now. Submissions are not accepted (D-133).

## 구성 / Layout

```
gallery/
  index.json          목록과 해시. 직접 고치지 않고 `npm run gallery:build`로 만든다
  presets/<slug>.json 프리셋 (blert preset install 이 받는 파일 형식 그대로)
  sounds/<slug>/      소리 테마: theme.json, up/down/account/warn.wav, LICENSE.md
  scripts/            목록 생성·검사
  tools/make_sounds.py 직접 합성한 소리 테마를 만드는 스크립트 (같은 결과가 다시 나온다)
```

## 설치 / Install

사이트의 명령은 이 저장소의 **특정 커밋** 주소와 해시를 씁니다. 같은 파일은 이렇게 설치합니다.

```bash
blert preset install https://raw.githubusercontent.com/eungangkim/Blert/<커밋>/gallery/presets/<slug>.json --sha256 <해시>
```

해시는 `index.json`의 `sha256` 값입니다. 로컬에서는 파일을 내려받아 `blert preset install ./<slug>.json`으로 설치해도 됩니다.

## 올리는 기준 / Rules

1. **라이선스:** 소리는 CC0 또는 직접 만든 것만 올리고 `theme.json`의 `license`는 `CC0-1.0`입니다 (D-84). 프리셋은 `CC0-1.0` 또는 `MIT`입니다. 소리 테마 폴더에는 출처·라이선스·가공 방법을 적은 `LICENSE.md`가 있어야 합니다.
2. **문구:** 이름과 설명은 상태를 알려 주는 말로 씁니다. 매수·매도 권유, 수익 보장, 추천으로 읽히는 표현은 쓰지 않습니다 (D-87⑤). 검사 스크립트가 일부 표현을 걸러 내지만 사람의 검토를 대신하지 않습니다.
3. **형식:** 모든 파일은 blert가 설치할 때 쓰는 검증기를 그대로 통과해야 합니다. 프리셋 `slug`는 파일 이름과 같고, 테마 폴더 이름은 슬러그 형식(영문 소문자·숫자·하이픈 3~40자)입니다.
4. **줄바꿈:** 이 폴더의 파일은 줄바꿈을 바꾸지 않습니다(`.gitattributes`). 해시가 파일의 바이트에 대한 것이기 때문입니다. 올린 뒤 내용을 바꾸면 해시도 바뀌므로 `version`을 올리고 `npm run gallery:build`를 다시 실행합니다.

## 확인 / Checks

```bash
npm run gallery:check   # 검사만 (문제가 있거나 index.json이 최신이 아니면 실패)
npm run gallery:build   # index.json 다시 쓰기
```

`npm test`에도 같은 검사가 들어 있습니다.
