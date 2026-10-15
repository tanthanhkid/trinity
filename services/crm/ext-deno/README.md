# ext-deno — phần chạy TRONG tiến trình Deno của chương trình con

Mã TIN CẬY (do Trinity viết), chạy bằng `deno run` ở tiến trình riêng, cách ly với monolith. Mã của khách/agent chỉ được nạp
bằng `import()` động từ URL `data:` rồi chạy dưới quyền khai trong manifest (`--allow-net=<host>`, không đọc/ghi file, không env, không chạy lệnh).
Không biên dịch bằng `tsc` (nằm ngoài `src/`); kiểm kiểu bằng `pnpm --filter @trinity/crm typecheck:deno`.

- `job-main.ts` — một tiến trình cho MỘT lần chạy (job theo lịch, chạy thử, gọi thử tool). Xong là thoát.
- `host.ts` + `worker-bootstrap.ts` — ext-host: MỘT tiến trình thường trú, mỗi tool là một Worker có quyền riêng.
- `ctx.ts` — SDK nhỏ chương trình con nhận (`ctx.records`, `ctx.log`); chỉ đi qua cổng nội bộ có token phạm vi.
- `module.ts` — chuẩn hoá mã khách thành bảng tool (`export default` hoặc `export const tools`).
