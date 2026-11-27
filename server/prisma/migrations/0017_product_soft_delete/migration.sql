-- Xoá sản phẩm = lưu trữ (xoá mềm) có Hoàn tác 10 phút; xoá HẲN chỉ Quản trị, chỉ khi chưa đơn/liên hệ nào dùng.
-- Chỉ THÊM cột có thể NULL — không đổi, không xoá dữ liệu cũ (sản phẩm hiện có đều deleted_at = NULL).
ALTER TABLE "products" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "products" ADD COLUMN "deleted_by" INTEGER;
