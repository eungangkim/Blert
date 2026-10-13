import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 모든 테스트는 한국어로 고정한다. OS 로캘이나 BLERT_LANG의 영향을 받지 않게 한다 (v1.4, AC-116)
    setupFiles: ['./test/setup.ts'],
  },
});
