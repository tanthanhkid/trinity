import { defineConfig, devices } from '@playwright/test'
import { FRAMES } from './e2e/helpers/frames'
import { bypassHeaders } from './e2e/helpers/vercel-bypass'

/**
 * Bộ kiểm tra giao diện tự động Trinity CRM (Playwright). Hướng dẫn: `e2e/README.md`.
 *
 * - `E2E_BASE_URL`        — mặc định `http://localhost:3000` (instance tự dựng).
 * - `E2E_BROWSER_CHANNEL` — `chrome` = dùng Google Chrome hệ thống (Chromium bundled
 *   của Playwright trên máy dev hỏng); mặc định `chromium` (bundled).
 * - `E2E_ALLOW_WRITE=1`   — bật seed/flows/cleanup (luồng có GHI dữ liệu, tiền tố `E2E-`).
 * - `E2E_WORKERS`         — số worker (mặc định 5; máy yếu thì đặt thấp).
 * - `VERCEL_AUTOMATION_BYPASS_SECRET` — chạy trên URL Vercel có bảo vệ (xem `e2e/helpers/vercel-bypass.ts`).
 */
const channel = process.env.E2E_BROWSER_CHANNEL
const useChannel = channel && channel !== 'chromium' ? { channel } : {}
const allowWrite = process.env.E2E_ALLOW_WRITE === '1'
/**
 * `E2E_PHASE` do `e2e/run-full.mjs` đặt: `read` = seed + các project đọc (smoke/rbac/design); `flows` = chỉ luồng ghi
 * (dùng dữ liệu seed trong manifest); không đặt = một lần chạy (seed → project chọn → cleanup làm teardown). Tách pha
 * vì (1) Playwright BỎ QUA project phụ thuộc khi 1 project đọc đỏ — lỗi sản phẩm đã ghi nhận không được chặn flows;
 * (2) flow bật/tắt công tắc tính năng tổ chức không được chạy song song với smoke.
 */
const phase = process.env.E2E_PHASE as 'read' | 'flows' | undefined
const tag = phase ?? 'all'
const readDeps = allowWrite && phase !== 'flows' ? ['setup', 'seed'] : ['setup']
const FRAME_KEYS = ['mobile', 'tablet', 'desktop'] as const

export default defineConfig({
  testDir: './e2e',
  outputDir: `./test-results/${tag}`,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: Number(process.env.E2E_WORKERS || 5),
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: `playwright-report/${tag}` }],
    ['json', { outputFile: `test-results/report-${tag}.json` }],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    headless: true,
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: bypassHeaders(),
    ...useChannel,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    // ── Bộ GHI dữ liệu thử (E2E_ALLOW_WRITE=1): seed → (đọc) → flows → cleanup. `cleanup` là TEARDOWN của
    //    `seed` nên chạy sau mọi project phụ thuộc, kể cả khi test đỏ. Không bật ghi: các project đọc chạy như cũ.
    ...(allowWrite
      ? [
          { name: 'cleanup', testMatch: /seed\/cleanup\.teardown\.ts/ }, // teardown: không được có dependencies (dùng token trong e2e/.auth do `setup` tạo)
          // Một lần chạy (không đặt E2E_PHASE): cleanup là teardown của seed. Chạy theo pha: run-full gọi cleanup riêng ở cuối.
          { name: 'seed', testMatch: /seed\/seed\.setup\.ts/, dependencies: ['setup'], ...(phase ? {} : { teardown: 'cleanup' }) },
        ]
      : []),
    ...(phase === 'flows'
      ? []
      : [
          { name: 'smoke', testMatch: /smoke\.spec\.ts/, dependencies: readDeps },
          { name: 'rbac-ui', testMatch: /rbac-ui\.spec\.ts/, dependencies: readDeps },
          { name: 'rbac-api', testMatch: /rbac-api\.spec\.ts/, dependencies: readDeps },
        ]),
    // Chuẩn thiết kế chạy ở 3 khung (điện thoại / iPad / máy tính) — xem `design/*.spec.ts`.
    ...(phase === 'flows' ? [] : FRAME_KEYS).map((f) => ({
      name: `design-${f}`,
      testMatch: /design\/.*\.spec\.ts/,
      dependencies: readDeps,
      metadata: { frame: f },
      use: {
        trace: 'off' as const, // read-only, ảnh chụp khi đỏ là đủ; trace của ~80 ca đỏ làm chậm cả lượt
        viewport: FRAMES[f].viewport,
        ...(FRAMES[f].touch ? { hasTouch: true, isMobile: f === 'mobile' } : {}),
      },
    })),
    // Luồng GHI (cần dữ liệu seed). Pha `flows`: không phụ thuộc seed (manifest đã có từ pha `read`).
    ...(allowWrite && phase !== 'read'
      ? [
          {
            name: 'flows',
            testMatch: /flows\/.*\.spec\.ts/,
            dependencies: phase === 'flows' ? ['setup'] : ['seed'],
            workers: 1,
          },
        ]
      : []),
  ],
})
