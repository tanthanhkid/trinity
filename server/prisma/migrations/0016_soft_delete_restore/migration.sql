-- Hoàn tác xoá phía máy chủ: ghi ai đã xoá (mềm) để chỉ người đó hoặc Quản trị khôi phục trong vài phút.
-- Chỉ THÊM cột có thể NULL — không đổi, không xoá dữ liệu cũ; bản ghi đã xoá trước đây có deleted_by = NULL (không khôi phục được qua API này).
ALTER TABLE "contacts" ADD COLUMN "deleted_by_id" INTEGER;
ALTER TABLE "kanban_cards" ADD COLUMN "deleted_by" INTEGER;
