import { defineConfig } from 'vitest/config'

// Chạy trực tiếp một hồ sơ: CONTRACT_PROFILE=default BASE_URL=... vitest run (bộ chạy `run.ts` làm việc này cho từng hồ sơ).
export default defineConfig({
  test: {
    include: process.env.CONTRACT_UNIT ? ['unit/**/*.test.ts'] : [`cases/${process.env.CONTRACT_PROFILE ?? 'default'}/**/*.test.ts`],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Một DB, một máy chủ: các ca chạy tuần tự để seed không giẫm nhau.
    fileParallelism: false,
    pool: 'forks',
    env: { TZ: 'UTC' },
  },
})
