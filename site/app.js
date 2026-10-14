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
let playing = null;
document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('button[data-play]') : null;
  if (!btn) return;
  if (playing) { playing.pause(); playing = null; }
  const audio = new Audio(btn.getAttribute('data-play') || '');
  playing = audio;
  audio.play().catch(() => {});
});
