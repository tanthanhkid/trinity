-- Chấm công › «Sửa giờ công kèm lý do»: lịch sử mỗi lần quản lý sửa giờ vào/ra của một ngày công (ai sửa, lý do, giờ cũ → giờ mới).
-- Xoá bản ghi chấm công thì lịch sử của nó đi theo; xoá người sửa thì giữ dòng, bỏ tên (editor_id → NULL).
-- Chạy lại nhiều lần cho cùng kết quả (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS "attendance_edits" (
    "id" SERIAL NOT NULL,
    "record_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "editor_id" INTEGER,
    "old_check_in_at" TIMESTAMPTZ(3),
    "old_check_out_at" TIMESTAMPTZ(3),
    "new_check_in_at" TIMESTAMPTZ(3),
    "new_check_out_at" TIMESTAMPTZ(3),
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_edits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "attendance_edits_record_id_created_at_idx" ON "attendance_edits"("record_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "attendance_edits_user_id_idx" ON "attendance_edits"("user_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_edits_record_id_fkey') THEN
    ALTER TABLE "attendance_edits" ADD CONSTRAINT "attendance_edits_record_id_fkey"
      FOREIGN KEY ("record_id") REFERENCES "attendance_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_edits_editor_id_fkey') THEN
    ALTER TABLE "attendance_edits" ADD CONSTRAINT "attendance_edits_editor_id_fkey"
      FOREIGN KEY ("editor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
