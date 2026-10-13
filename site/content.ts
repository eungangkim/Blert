/**
 * 사이트 문구 (한국어·영어). 값은 신뢰하는 HTML 조각이다(직접 쓴 문구). 갤러리 항목처럼 바깥에서 오는 값은 build.ts에서 이스케이프한다.
 * 문구 원칙(D-87⑤, LEGAL_CHECKLIST B1~B3): 수익·성과·매수·매도 권유로 읽히는 표현을 쓰지 않고, 검증하지 못한 환경을 검증된 것처럼 쓰지 않는다(D-89).
 */
export type Lang = 'ko' | 'en';
export type PageId = 'index' | 'start' | 'gallery' | 'trust' | 'privacy';
export const PAGES: readonly PageId[] = ['index', 'start', 'gallery', 'trust', 'privacy'];

export const REPO = 'https://github.com/eungangkim/Blert';
export const NPM = 'https://www.npmjs.com/package/@eungang/blert';

interface Content {
  lang: Lang;
  htmlLang: string;
  siteName: string;
  nav: Record<PageId, string>;
  switchLabel: string;
  skip: string;
  copy: string;
  copied: string;
  footer: { disclaimer: string; affiliation: string; links: { repo: string; npm: string; security: string; license: string } };
  titles: Record<PageId, string>;
  descriptions: Record<PageId, string>;
  home: {
    h1: string;
    lead: string;
    installTitle: string;
    installNote: string;
    features: { title: string; body: string }[];
    envTitle: string;
    envBody: string;
    ctaStart: string;
    ctaGallery: string;
  };
  start: { h1: string; lead: string; steps: { title: string; body: string; code?: string }[]; moreTitle: string; more: string };
  gallery: {
    h1: string;
    lead: string;
    notice: string;
    presetsTitle: string;
    themesTitle: string;
    needsKey: string;
    noKey: string;
    rules: string;
    installLabel: string;
    hashLabel: string;
    soundsLabel: string;
    themeHashNote: string;
    reqPreset: string;
    reqTheme: string;
    themeText: Record<string, string>;
    typeNames: Record<string, string>;
    verifyTitle: string;
    verify: string;
  };
  trust: { h1: string; lead: string; sections: { title: string; items: string[] }[] };
  privacy: { h1: string; body: string[] };
  sponsor: { title: string; body: string };
}

export const KO: Content = {
  lang: 'ko',
  htmlLang: 'ko',
  siteName: 'blert',
  nav: { index: '소개', start: '시작하기', gallery: '갤러리', trust: '신뢰', privacy: '개인정보' },
  switchLabel: 'English',
  skip: '본문으로 건너뛰기',
  copy: '복사',
  copied: '복사됨',
  footer: {
    disclaimer: 'blert는 투자 조언이 아니며, 알림 누락·지연으로 생긴 손실에 책임지지 않습니다.',
    affiliation: 'blert는 바이낸스(Binance)와 제휴하거나 승인받은 도구가 아니며, 독립적으로 만든 오픈소스(MIT)입니다.',
    links: { repo: 'GitHub', npm: 'npm', security: '보안 신고', license: '라이선스' },
  },
  titles: {
    index: 'blert — 내 PC에서만 도는 바이낸스 알림',
    start: '시작하기 — blert',
    gallery: '갤러리 — blert',
    trust: '신뢰 — blert',
    privacy: '개인정보 — blert',
  },
  descriptions: {
    index: '바이낸스 현물·선물 알림을 명령어로 설정하고 내 PC에서 데스크톱 알림·소리·음성으로 받는 오픈소스 CLI. 서버가 없고 키와 데이터는 PC 밖으로 나가지 않습니다.',
    start: '설치부터 첫 알림까지 1분 안에 따라 하는 순서.',
    gallery: '바로 설치할 수 있는 프리셋과 알림 소리 테마. 해시를 확인하고 설치합니다.',
    trust: 'blert가 무엇을 하고 하지 않는지: 데이터 경계, 읽기 전용 키, 공개 소스, 알려진 한계.',
    privacy: '이 사이트는 방문 정보를 수집하지 않습니다.',
  },
  home: {
    h1: '내 PC에서만 도는 바이낸스 알림',
    lead: '가격, 변동률, 거래량, 펀딩비, 내 체결과 청산가 근접을 명령어 한 줄로 설정하고 데스크톱 알림과 소리·음성으로 받습니다. 서버가 없고, API 키와 설정은 이 PC 밖으로 나가지 않습니다.',
    installTitle: '바로 시작',
    installNote: 'Node.js 24 이상이 필요합니다. 첫 실행에서 초기 설정(고지 동의, 언어, 소리, 프리셋)을 안내합니다.',
    features: [
      {
        title: '키와 데이터가 PC 밖으로 나가지 않습니다',
        body: '서버도 회원가입도 없습니다. 사용 정보를 어디로도 보내지 않고, 네트워크 요청은 바이낸스로만 갑니다. 텔레그램 같은 알림 채널은 직접 켠 경우에만 쓰입니다.',
      },
      {
        title: '읽기 전용 키만 받습니다',
        body: '거래·출금 권한이 켜진 키는 저장도 실행도 거부합니다. 키는 파일이 아니라 OS 키체인에만 저장됩니다.',
      },
      {
        title: '소리와 음성으로 받습니다',
        body: '알림 종류별 소리를 내 소리로 바꾸고, PC에 내장된 음성이 알림을 읽어 주게 할 수 있습니다. 클라우드 음성은 쓰지 않습니다.',
      },
      {
        title: '청산 단계 경고',
        body: '<code>blert add liq f:BTC 10%,5%,2%</code> — 청산가에 가까워질 때마다 단계별로 바로 알립니다. 읽기 전용 키가 필요합니다.',
      },
    ],
    envTitle: '지원 환경',
    envBody: 'Windows 11에서 알림·소리·데몬·계정 알림을 직접 확인했습니다. macOS와 Linux는 자동 테스트만 통과했고 직접 확인하지 못했습니다. 써 보신 결과를 GitHub 이슈로 알려 주세요.',
    ctaStart: '시작하기',
    ctaGallery: '갤러리 보기',
  },
  start: {
    h1: '시작하기',
    lead: '설치부터 첫 알림까지의 순서입니다. 모든 명령에는 <code>--help</code>가 있습니다.',
    steps: [
      { title: '1. 초기 설정', body: '고지에 동의하고 언어, 소리, 프리셋을 고릅니다.', code: 'npx @eungang/blert init' },
      { title: '2. 프리셋 설치 (선택)', body: '여러 알림을 한 번에 등록합니다.', code: 'blert preset install major-swing' },
      { title: '3. 알림 추가', body: '가격, 변동률, 거래량, 펀딩비를 한 줄로 설정합니다.', code: 'blert add price BTC above 70000\nblert add change ETH 5% 1h down\nblert add funding f:BTC above 0.05%' },
      { title: '4. 감시 시작', body: '터미널을 열어 둔 동안 감시합니다. 닫아도 계속하려면 <code>blert start</code>를 씁니다.', code: 'blert run' },
    ],
    moreTitle: '더 알아보기',
    more: '계정 알림(읽기 전용 키), 데몬, 자동 시작, 소리 등록, 음성 알림, 프리셋 공유는 <a href="{repo}#readme">README</a>에 있습니다.',
  },
  gallery: {
    h1: '갤러리',
    lead: '작성자가 직접 만든 프리셋과 알림 소리 테마입니다. 사용자 제출은 받지 않습니다.',
    notice: '프리셋은 알림 규칙의 모음일 뿐이며 투자 권유가 아닙니다. 설치하기 전에 규칙을 확인하세요.',
    presetsTitle: '프리셋',
    themesTitle: '소리 테마',
    needsKey: '읽기 전용 API 키 필요',
    noKey: 'API 키 없이 동작',
    rules: '규칙 {n}개',
    installLabel: '설치',
    hashLabel: 'SHA-256',
    soundsLabel: '소리 4종 (올림·내림·계정·경고)',
    themeHashNote: '소리 파일마다 theme.json에 해시가 들어 있어 설치할 때 자동으로 확인합니다.',
    reqPreset: 'blert 1.2 이상 필요',
    reqTheme: 'blert 1.1 이상 필요',
    themeText: {
      'soft-chime': '부드러운 종소리. 올라가는 두 음, 내려가는 두 음, 맑은 종 한 번, 같은 음 세 번(경고).',
      'retro-beep': '짧은 8비트풍 삑 소리. 오르내리는 3음, 높은 두 음, 번갈아 세 번(경고).',
    },
    typeNames: { price: '가격', change: '변동률', volume: '거래량', funding: '펀딩비', fill: '체결', balance: '잔고', liq: '청산가' },
    verifyTitle: '설치 전에 확인하는 법',
    verify: '아래 명령의 주소는 이 저장소의 <strong>특정 커밋</strong>을 가리키고, <code>--sha256</code>으로 내려받은 파일이 이 페이지의 해시와 같을 때만 설치합니다. blert는 설치 전에 출처, 규칙 요약, 해시를 보여 주고 동의(y/N)를 받습니다. 해시 원본은 <a href="{repo}/blob/main/gallery/index.json">공개 저장소의 index.json</a>입니다.',
  },
  trust: {
    h1: '신뢰',
    lead: '키를 다루는 도구라서 무엇을 하고 무엇을 하지 않는지 먼저 밝힙니다.',
    sections: [
      {
        title: '데이터가 어디로 가나요',
        items: [
          '서버, 회원가입, 로그인이 없습니다. 사용 정보(텔레메트리), 익명 통계, 업데이트 확인도 보내지 않습니다.',
          '네트워크 요청은 바이낸스 서버로만 갑니다.',
          '예외 두 가지: (1) 내가 직접 켠 알림 채널(텔레그램)로 알림 문구가 갑니다. (2) 내가 명령에 직접 입력한 https 주소에서 프리셋·소리 파일을 내려받습니다(GET만, 내 정보를 보내지 않음).',
        ],
      },
      {
        title: '키는 어떻게 다루나요',
        items: [
          '읽기 전용 Ed25519 키만 받습니다. 거래·출금·마진·선물 권한이 하나라도 켜진 키는 저장도 실행도 거부합니다.',
          '키는 OS 키체인에만 저장하고 파일, 설정, 로그, 오류 메시지에 남기지 않습니다.',
          '허용 IP 제한이 없는 키는 실행할 때마다 경고합니다.',
        ],
      },
      {
        title: '직접 확인할 수 있습니다',
        items: [
          '소스 전체와 설계 문서를 공개합니다(MIT). 아직 고치지 않은 취약점의 세부 내용만 수정 뒤에 공개합니다.',
          'npm 배포는 provenance 서명으로 합니다. 설치 전에 서명 표시를 확인하세요.',
          '런타임 의존성은 10개 이하이고 버전을 고정합니다(현재 1개).',
          '보안 문제는 GitHub의 <a href="{repo}/security">비공개 신고</a>로 알려 주세요.',
        ],
      },
      {
        title: '알려진 한계',
        items: [
          'blert는 투자 조언이 아닙니다. 연결 끊김, 절전, 프로그램 종료로 알림이 늦거나 누락될 수 있고, 그로 인한 손실에 책임지지 않습니다. 감시가 멈춘 구간은 다음 실행에서 알려 줍니다.',
          'Windows 11 외 환경(macOS, Linux)은 아직 직접 확인하지 못했습니다.',
          '컴퓨터가 꺼져 있으면 알림은 오지 않습니다. 클라우드에서 대신 돌려 주는 기능은 만들지 않습니다.',
        ],
      },
    ],
  },
  privacy: {
    h1: '개인정보',
    body: [
      '이 사이트는 쿠키, 방문 통계, 광고, 외부 글꼴·스크립트를 쓰지 않으며 방문 정보를 수집하지 않습니다. 문의 폼도 없습니다.',
      '사이트가 올라가 있는 호스팅 서비스는 자체 정책에 따라 접속 기록을 남길 수 있습니다. 이는 이 사이트가 받는 정보가 아닙니다.',
      '이 사이트는 API 키, 개인키, 계정 정보를 묻지 않습니다. 누가 그런 것을 요구하면 이 사이트가 아닙니다.',
      '문의와 제안은 GitHub 이슈로 받습니다. 모든 문의에 답하지는 못합니다.',
    ],
  },
  sponsor: {
    title: '후원',
    body: 'blert는 무료 오픈소스입니다. 도움이 되었다면 후원으로 개발을 응원해 주실 수 있습니다. 후원은 기능, 지원 우선권, 알림 동작과 무관하며 후원자 이름은 공개하지 않습니다.',
  },
};

export const EN: Content = {
  lang: 'en',
  htmlLang: 'en',
  siteName: 'blert',
  nav: { index: 'About', start: 'Get started', gallery: 'Gallery', trust: 'Trust', privacy: 'Privacy' },
  switchLabel: '한국어',
  skip: 'Skip to content',
  copy: 'Copy',
  copied: 'Copied',
  footer: {
    disclaimer: 'blert is not investment advice, and is not responsible for losses caused by missed or delayed alerts.',
    affiliation: 'blert is not affiliated with or endorsed by Binance. It is an independent open-source project (MIT).',
    links: { repo: 'GitHub', npm: 'npm', security: 'Report a vulnerability', license: 'License' },
  },
  titles: {
    index: 'blert — Binance alerts that run only on your PC',
    start: 'Get started — blert',
    gallery: 'Gallery — blert',
    trust: 'Trust — blert',
    privacy: 'Privacy — blert',
  },
  descriptions: {
    index: 'An open-source CLI that sets up Binance spot and futures alerts with commands and delivers them on your own PC as desktop notifications, sounds and voice. No server; your keys and data never leave the PC.',
    start: 'From install to your first alert in about a minute.',
    gallery: 'Ready-to-install presets and alert sound themes. Check the hash, then install.',
    trust: 'What blert does and does not do: the data boundary, read-only keys, open source, known limits.',
    privacy: 'This site does not collect visitor information.',
  },
  home: {
    h1: 'Binance alerts that run only on your PC',
    lead: 'Set up price, change, volume, funding rate, your own fills and liquidation-price proximity with one command each, and receive them as desktop notifications, sounds and voice. There is no server, and your API keys and settings never leave this PC.',
    installTitle: 'Start now',
    installNote: 'Requires Node.js 24 or later. The first run walks you through setup (notice, language, sound, presets).',
    features: [
      {
        title: 'Your keys and data stay on your PC',
        body: 'No server and no sign-up. blert sends no usage information anywhere, and network requests go only to Binance. An alert channel such as Telegram is used only if you turn it on yourself.',
      },
      {
        title: 'Read-only keys only',
        body: 'Keys with trading or withdrawal permission are refused at both save and run time. Keys are stored in the OS keychain, not in files.',
      },
      {
        title: 'Sounds and voice',
        body: 'Swap the sound for each alert kind with your own, and let your PC’s built-in voice read alerts aloud. No cloud voice is used.',
      },
      {
        title: 'Staged liquidation warnings',
        body: '<code>blert add liq f:BTC 10%,5%,2%</code> — alerts immediately at each stage as you get closer to your liquidation price. Needs a read-only key.',
      },
    ],
    envTitle: 'Supported environments',
    envBody: 'Alerts, sound, the daemon and account alerts were checked on Windows 11. macOS and Linux have passed automated tests only and have not been checked by hand. Please report how it goes in a GitHub issue.',
    ctaStart: 'Get started',
    ctaGallery: 'Browse the gallery',
  },
  start: {
    h1: 'Get started',
    lead: 'From install to your first alert. Every command has <code>--help</code>.',
    steps: [
      { title: '1. Initial setup', body: 'Accept the notice, then pick your language, sound and presets.', code: 'npx @eungang/blert init' },
      { title: '2. Install a preset (optional)', body: 'Register several alerts at once.', code: 'blert preset install major-swing' },
      { title: '3. Add alerts', body: 'Price, change, volume and funding rate in one line each.', code: 'blert add price BTC above 70000\nblert add change ETH 5% 1h down\nblert add funding f:BTC above 0.05%' },
      { title: '4. Start watching', body: 'Watches while the terminal stays open. Use <code>blert start</code> to keep going after you close it.', code: 'blert run' },
    ],
    moreTitle: 'Learn more',
    more: 'Account alerts (read-only key), the daemon, auto-start, custom sounds, voice alerts and preset sharing are covered in the <a href="{repo}/blob/main/README.en.md">README</a>.',
  },
  gallery: {
    h1: 'Gallery',
    lead: 'Presets and alert sound themes made by the author. Submissions are not accepted.',
    notice: 'A preset is just a set of alert rules, not an investment recommendation. Check the rules before you install.',
    presetsTitle: 'Presets',
    themesTitle: 'Sound themes',
    needsKey: 'Needs a read-only API key',
    noKey: 'Works without an API key',
    rules: '{n} rules',
    installLabel: 'Install',
    hashLabel: 'SHA-256',
    soundsLabel: '4 sounds (up, down, account, warning)',
    themeHashNote: 'theme.json carries a hash for each sound file, and blert checks them automatically when installing.',
    reqPreset: 'Requires blert 1.2 or later',
    reqTheme: 'Requires blert 1.1 or later',
    themeText: {
      'soft-chime': 'A soft bell. Two rising notes, two falling notes, one clear bell, and the same note three times for warnings.',
      'retro-beep': 'Short 8-bit style beeps. Rising and falling three-note runs, two high notes, and an alternating triple for warnings.',
    },
    typeNames: { price: 'price', change: 'change', volume: 'volume', funding: 'funding', fill: 'fills', balance: 'balance', liq: 'liquidation' },
    verifyTitle: 'How to verify before installing',
    verify: 'The addresses below point at a <strong>specific commit</strong> of this repository, and <code>--sha256</code> makes blert install only if the downloaded file matches the hash on this page. Before installing, blert shows the source, a rule summary and the hash, and asks for consent (y/N). The source of the hashes is <a href="{repo}/blob/main/gallery/index.json">index.json in the public repository</a>.',
  },
  trust: {
    h1: 'Trust',
    lead: 'blert handles API keys, so here is what it does and does not do.',
    sections: [
      {
        title: 'Where does your data go?',
        items: [
          'There is no server, sign-up or login. blert sends no usage information, anonymous statistics or update checks.',
          'Network requests go only to Binance servers.',
          'Two exceptions: (1) alert text goes to an alert channel (Telegram) that you turned on yourself. (2) Preset and sound files are downloaded from an https address you typed into a command (GET only, nothing about you is sent).',
        ],
      },
      {
        title: 'How are keys handled?',
        items: [
          'Only read-only Ed25519 keys are accepted. A key with any trading, withdrawal, margin or futures permission is refused at both save and run time.',
          'Keys live only in the OS keychain and are never written to files, settings, logs or error messages.',
          'A key without an IP restriction triggers a warning every time blert runs.',
        ],
      },
      {
        title: 'You can check for yourself',
        items: [
          'The full source and design documents are public (MIT). Only the details of a not-yet-fixed vulnerability are published after the fix.',
          'npm releases are published with provenance signatures. Check the signature badge before installing.',
          'Runtime dependencies are capped at 10 and pinned (currently 1).',
          'Report security problems through GitHub’s <a href="{repo}/security">private reporting</a>.',
        ],
      },
      {
        title: 'Known limits',
        items: [
          'blert is not investment advice. Dropped connections, sleep or the program being closed can delay or miss alerts, and blert is not responsible for resulting losses. Gaps in monitoring are reported the next time it runs.',
          'Environments other than Windows 11 (macOS, Linux) have not been checked by hand yet.',
          'No alerts arrive while your computer is off. A cloud service that runs alerts for you will not be built.',
        ],
      },
    ],
  },
  privacy: {
    h1: 'Privacy',
    body: [
      'This site uses no cookies, visitor statistics, ads, or external fonts and scripts, and it does not collect visitor information. There is no contact form.',
      'The hosting service this site is served from may keep access logs under its own policy. That is not information this site receives.',
      'This site never asks for API keys, private keys or account details. Anyone asking for them is not this site.',
      'Questions and suggestions go through GitHub issues. Not every message can be answered.',
    ],
  },
  sponsor: {
    title: 'Support',
    body: 'blert is free and open source. If it helps you, you can support development with a sponsorship. Sponsorship does not affect features, support priority or how alerts work, and sponsors’ names are not published.',
  },
};
