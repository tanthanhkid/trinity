-- Giai đoạn làm việc của nhân viên: khoá rồi mở khoá không còn làm mất khoảng thời gian bị khoá trong chấm công cũ.
-- Chỉ THÊM bảng + index — không đổi, không xoá dữ liệu cũ, không điền sẵn dòng nào. Nhân viên chưa có dòng
-- giữ nguyên luật roster cũ (status + resigned_at); dòng đầu được dựng từ luật cũ khi trạng thái đổi lần đầu.
CREATE TABLE "employment_periods" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "started_on" DATE,
    "ended_on" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employment_periods_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "employment_periods_employee_id_idx" ON "employment_periods"("employee_id");

-- Tối đa 1 giai đoạn đang mở mỗi nhân viên (Prisma không khai được unique một phần).
CREATE UNIQUE INDEX "employment_periods_one_open_idx" ON "employment_periods"("employee_id") WHERE "ended_on" IS NULL;

ALTER TABLE "employment_periods" ADD CONSTRAINT "employment_periods_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
