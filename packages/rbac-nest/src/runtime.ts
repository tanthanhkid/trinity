/**
 * Chạy một việc nền sau khi trả response (fire-and-forget): process máy chủ luôn sống nên promise tự chạy xong.
 * Không bao giờ ném lỗi, không bao giờ chặn response; lỗi của task đi qua `onError` (mặc định nuốt).
 */
export function runInBackground(task: () => Promise<unknown>, onError: (err: unknown) => void = () => undefined): void {
  void Promise.resolve()
    .then(task)
    .catch((err: unknown) => {
      try {
        onError(err)
      } catch {
        /* nuốt */
      }
    })
}
