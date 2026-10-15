import { PrismaClient } from '@prisma/client';

/**
 * Các `*.db.spec.ts` dùng CHUNG một DB và TRUNCATE đầu mỗi test, nên jest chạy song song là giẫm nhau. Gọi hàm này ở dòng đầu
 * của `describe`: nó giữ một khoá tư vấn Postgres (pg_advisory_xact_lock, trên kết nối riêng) suốt file spec — file khác chờ tới
 * khi file này xong. Khoá tự nhả khi kết nối đóng, kể cả khi tiến trình chết. Không cần `--runInBand`, không đụng cấu hình CI.
 */
const LOCK_KEY = 7_420_251_012;
const WAIT_MS = 600_000;

export function useDbSpecLock(url: string): void {
  let holder: PrismaClient | undefined;
  let release: (() => void) | undefined;
  let done: Promise<unknown> | undefined;

  beforeAll(async () => {
    holder = new PrismaClient({ datasourceUrl: url });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    done = holder.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
      acquired();
      await held;
    }, { maxWait: WAIT_MS, timeout: WAIT_MS * 2 });
    done.catch(() => acquired());
    await ready;
  }, WAIT_MS);

  afterAll(async () => {
    release?.();
    await done?.catch(() => undefined);
    await holder?.$disconnect();
  });
}
