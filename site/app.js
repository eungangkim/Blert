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
