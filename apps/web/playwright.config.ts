import { defineConfig, devices } from '@playwright/test'
import { FRAMES } from './e2e/helpers/frames'

/**
 * Bộ kiểm tra giao diện tự động Trinity CRM (Playwright). Hướng dẫn: `e2e/README.md`.
 *
 * - `E2E_BASE_URL`        — mặc định `http://localhost:3000` (instance tự dựng).
 * - `E2E_BROWSER_CHANNEL` — `chrome` = dùng Google Chrome hệ thống (Chromium bundled
 *   của Playwright trên máy dev hỏng); mặc định `chromium` (bundled).
 * - `E2E_ALLOW_WRITE=1`   — bật seed/flows/cleanup (luồng có GHI dữ liệu, tiền tố `E2E-`).
 * - `E2E_WORKERS`         — số worker (mặc định 5; máy yếu thì đặt thấp).
 * - `E2E_SERVER=rust`     — W04: Playwright tự khởi động binary `trinity serve` phục vụ web tĩnh `out/` (K18, W02a:
 *   `pnpm build:export` trước), thay cho `next start`/standalone. Biến phụ: `E2E_RUST_BIN` (mặc định
 *   `../../server/target/release/trinity`), `E2E_WEB_DIR` (mặc định `./out`), `E2E_RUST_PORT` (mặc định 3300). Biến
 *   của binary (DATABASE_URL, JWT_SECRET, ...) lấy từ môi trường chạy. Không đặt = như cũ, dùng instance có sẵn ở
 *   `E2E_BASE_URL` (không tự khởi động gì).
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
/**
 * Chế độ binary Rust. Binary chạy một mình (không tệp sở hữu, không NODE_FALLBACK_URL) nên Rust nhận mọi route và, vì
 * có `WEB_DIR`, tự phục vụ trang web (xem `trinity-bin/src/serve.rs`). `/api/v1/health` là cổng sẵn sàng.
 */
const rustServer = process.env.E2E_SERVER === 'rust'
const rustPort = Number(process.env.E2E_RUST_PORT || 3300)
const rustUrl = `http://127.0.0.1:${rustPort}`
// Helper dùng API (`helpers/api.ts`) đọc E2E_BASE_URL từ môi trường: đặt trước khi worker sinh ra.
if (rustServer && !process.env.E2E_BASE_URL) process.env.E2E_BASE_URL = rustUrl
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
    baseURL: process.env.E2E_BASE_URL || (rustServer ? rustUrl : 'http://localhost:3000'),
    headless: true,
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    ...useChannel,
    // macOS: Chromium headless không được hỏi Keychain («Chromium Safe Storage»).
    launchOptions: { args: ['--use-mock-keychain'] },
  },
  ...(rustServer
    ? {
        webServer: {
          command: `${process.env.E2E_RUST_BIN || '../../server/target/release/trinity'} serve`,
          url: `${rustUrl}/api/v1/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: 'pipe' as const,
          stderr: 'pipe' as const,
          env: {
            ...(process.env as Record<string, string>),
            TRINITY_HTTP_PORT: String(rustPort),
            WEB_DIR: process.env.E2E_WEB_DIR || './out',
          },
        },
      }
    : {}),
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
    // #675: đăng nhập bằng mã/link qua email, đọc thư từ SMTP giả trong tiến trình test (`E2E_SMTP_PORT`, máy chủ chạy với
    // SMTP_HOST=127.0.0.1 SMTP_SECURITY=none — `server/scripts/e2e-rust.sh email-login` tự đặt). Không thư nào ra ngoài.
    ...(process.env.E2E_SMTP_PORT ? [{ name: 'email-login', testMatch: /email-login\.spec\.ts/, workers: 1 }] : []),
    // W04: web tĩnh do Rust phục vụ — URL sâu, điều hướng, nút quay lại, prefetch của 8 route động + luật điều hướng.
    { name: 'static-web', testMatch: /static-web\.spec\.ts/, dependencies: ['setup'] },
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
