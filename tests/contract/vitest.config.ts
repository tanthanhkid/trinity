import { defineConfig } from 'vitest/config'
import { PathSequencer } from './lib/sequencer.js'

// Các ca cần máy chủ, DB và nhiều biến CONTRACT_* do bộ chạy đặt: chạy qua `pnpm contract [-- --profile <hồ sơ>]`, không gọi vitest trực tiếp.
// `pnpm test` (CONTRACT_UNIT=1) chỉ chạy test đơn vị, không cần Postgres.
export default defineConfig({
  test: {
    include: process.env.CONTRACT_UNIT ? ['unit/**/*.test.ts'] : [`cases/${process.env.CONTRACT_PROFILE ?? 'default'}/**/*.test.ts`],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Một DB, một máy chủ: các ca chạy tuần tự để seed không giẫm nhau.
    fileParallelism: false,
    sequence: { sequencer: PathSequencer },
    pool: 'forks',
    env: { TZ: 'UTC' },
  },
})
