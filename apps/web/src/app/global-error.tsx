"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="vi">
      <body>
        <div style={{ padding: "2rem", textAlign: "center" }}>
          <h2>Trinity gặp sự cố khi mở trang</h2>
          {/* Không in error.message: chữ kỹ thuật không giúp người dùng sửa được gì. */}
          <p>Bấm &quot;Thử lại&quot;; vẫn lỗi thì tải lại trang hoặc báo quản trị viên kèm thời điểm xảy ra.</p>
          <button onClick={() => reset()} style={{ marginTop: "1rem", padding: "0.5rem 1rem" }}>
            Thử lại
          </button>
        </div>
      </body>
    </html>
  );
}
