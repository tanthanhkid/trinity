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
          <h2>Đã xảy ra lỗi</h2>
          <p>{error.message}</p>
          <button onClick={() => reset()} style={{ marginTop: "1rem", padding: "0.5rem 1rem" }}>
            Thử lại
          </button>
        </div>
      </body>
    </html>
  );
}
