/** Hướng dẫn viết chương trình con cho AI — nằm trong mô tả tool để agent hiểu hợp đồng mã + giới hạn (không cần đoán). */
export const EXTENSION_GUIDE =
  'CHƯƠNG TRÌNH CON = đoạn TypeScript nhỏ chạy trên Deno, CÁCH LY khỏi hệ thống chính (lỗi không ảnh hưởng ứng dụng). Ba loại: ' +
  'job (chạy theo lịch, vd đồng bộ dữ liệu), tool (một công cụ MCP mới cho agent), api (CHƯA chạy được). ' +
  'MÃ job: `export default async function (ctx) { … return kếtQuả }`. ' +
  'MÃ tool: `export default async function (args, ctx) { … }` (một tool) hoặc `export const tools = { ten: { description, inputSchema, run(args, ctx) } }`. ' +
  '`ctx` có: `ctx.params`, `ctx.dryRun` (true khi chạy thử), `ctx.log(...)`, `ctx.records.create(bảng, [dòng…])` (≤500 dòng/lần), `ctx.records.list(bảng, {limit, cursor})`. ' +
  'Chỉ dùng `fetch` và API web chuẩn: KHÔNG import npm/URL ngoài, KHÔNG đọc/ghi file, KHÔNG biến môi trường, KHÔNG chạy lệnh. ' +
  'Mạng chỉ ra được các host khai trong manifest.net (tên miền, không ký tự đại diện, không địa chỉ nội bộ). ' +
  'Dữ liệu chỉ đi qua `ctx.records` và CHỈ các bảng tuỳ biến khai trong manifest.tables.read/write (khoá bảng từ describe_schema); bảng ngoài phạm vi ⇒ 403. ' +
  'manifest = { net: ["api.example.com"], tables: { read: ["khach_hang"], write: ["khach_hang"] }, schedule: "0 8 * * *" (chỉ job; 5 trường, giờ VN, tối thiểu 5 phút/lần), input_schema: {type:"object",properties:{…}} (chỉ tool), limits: {timeoutMs, memoryMb} }. ' +
  'QUY TRÌNH: create_extension (nháp) → dry_run_extension (chạy thử, KHÔNG ghi thật, trả log + kết quả) → NGƯỜI duyệt trong Trinity (mục Chương trình con) → deploy_extension. ' +
  'Bạn không thể tự duyệt. Sửa = update_extension (tạo phiên bản mới), quay lui = rollback_extension. ' +
  'Chỉ xin quyền (host mạng, bảng) thật sự cần — người duyệt sẽ đọc từng dòng.';
