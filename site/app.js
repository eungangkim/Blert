// 코드 블록의 복사 버튼. 외부 요청 없음.
document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('button[data-copy]') : null;
  if (!btn) return;
  const code = btn.parentElement && btn.parentElement.querySelector('code');
  if (!code || !navigator.clipboard) return;
  navigator.clipboard.writeText(code.textContent || '').then(() => {
    const label = btn.textContent;
    btn.textContent = document.body.dataset.copied || 'OK';
    setTimeout(() => { btn.textContent = label; }, 1500);
  }).catch(() => {});
});

// 소리 미리듣기. 이 사이트 안의 WAV 파일만 재생하고 외부 요청은 없다. 한 번에 하나만 재생한다.
// 재생이 시작되면 버튼에 ■ 표시를 하고, 실패하면 ✕와 이유를 보여 준다 (소리가 안 날 때 원인을 알 수 있도록).
let playing = null;
function reset(btn) {
  const label = btn.getAttribute('data-label');
  if (label) btn.textContent = label;
}
document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('button[data-play]') : null;
  if (!btn) return;
  if (!btn.hasAttribute('data-label')) btn.setAttribute('data-label', btn.textContent || '');
  if (playing) { playing.audio.pause(); reset(playing.btn); playing = null; }
  const audio = new Audio(btn.getAttribute('data-play') || '');
  playing = { audio, btn };
  const fail = (why) => { btn.textContent = '✕ ' + (btn.getAttribute('data-label') || '').replace(/^▶ /, ''); btn.title = why; };
  audio.addEventListener('playing', () => { btn.textContent = '■ ' + (btn.getAttribute('data-label') || '').replace(/^▶ /, ''); btn.title = ''; });
  audio.addEventListener('ended', () => reset(btn));
  audio.addEventListener('error', () => fail('error ' + (audio.error ? audio.error.code : '')));
  audio.play().catch((err) => fail(err && err.name ? err.name : 'play'));
});
