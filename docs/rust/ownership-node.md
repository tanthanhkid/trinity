# Bản TS theo tệp sở hữu (T01)

Trong giai đoạn lai, mỗi job nền chỉ có một chủ (`rust` hoặc `node`) ghi trong tệp `TRINITY_OWNERSHIP_FILE`
(định dạng và bộ đọc phía Rust: `server/crates/trinity-kernel/src/ownership.rs`, PLAN 4.14).

Phía Node (`packages/rbac-nest/src/ownership.ts`):

- Đọc lại tệp ở **đầu mỗi lượt tick** (so thời điểm sửa, kích thước, inode nên đổi tên nguyên tử cũng nhận ra); không cần
  khởi động lại. Job ghi `rust` thì Node bỏ lượt (lượt đang chạy dở chạy nốt); không ghi hoặc ghi `node` thì Node chạy.
- Phạm vi: mọi timer qua `tenantTimerTick` (tham số `jobName`, 11 job của `cronRegistry`: `integrations.webhook-dispatch`,
  `facebook.flows`, `facebook.broadcasts`, `social.publish`, `social.metrics`, `briefings.run-due`, `lead-scoring.run`,
  `stale-work.digest`, `integrations.ai-action-expiry`, `integrations.outbox-purge`, `integrations.oauth-purge`),
  `@Cron` của `notification.scheduled`, và migrate nền lúc boot (`migrate: rust` thì Node không chạy
  `migrateAllCompanies`; chỉ đọc một lần lúc boot vì bước này chỉ chạy một lần).
- Tệp hỏng hoặc không đọc được: giữ bảng đang dùng và ghi lỗi một lần cho mỗi phiên bản tệp; chưa có bảng nào thì mọi thứ
  thuộc Node. Khoá lạ, chủ khác `rust|node`, tên job có khoảng trắng đầu/cuối bị từ chối như bộ đọc Rust. Khác biệt:
  bộ đọc TS không bắt khoá `jobs` trùng và không kiểm sâu `routes` (Rust từ chối cả tệp).
- Không có khoá chéo tiến trình ở Node: hai bên cùng đọc một tệp nên mỗi job chỉ một bên chạy.
