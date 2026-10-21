import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.tsx'],
    // Lần `await import()` đầu của một trang nặng (vd /login) phải biên dịch cả cây module; khi chạy cả bộ song song
    // trên máy chậm (Windows) việc đó vượt 5s mặc định ⇒ test đỏ dù không lỗi. 15s đủ dư, test treo thật vẫn bị bắt.
    testTimeout: 15_000,
    // `e2e/**` là test PLAYWRIGHT (`test.describe`, `page.goto`) — glob mặc
    // định của vitest khớp mọi `*.spec.ts` nên nó nhặt luôn 13 file đó vào rồi
    // báo đỏ, dù chúng chưa bao giờ được viết để chạy dưới vitest — nhiễu che
    // mất các file đỏ THẬT. Giữ nguyên `node_modules`/`dist` của mặc định.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'e2e/**'],
    // vitest ≥ 4 chỉ tính file đã được test nạp; khai rõ để báo cáo coverage vẫn gồm cả mã chưa có test.
    coverage: { include: ['src/**/*.{ts,tsx}'], exclude: ['src/**/__tests__/**', 'src/**/*.d.ts'] },
  },
  resolve: {
    alias: {
      '#nest-loader': path.resolve(__dirname, './src/lib/nest-loader.ts'),
      '@': path.resolve(__dirname, './src'),
    },
  },
})
