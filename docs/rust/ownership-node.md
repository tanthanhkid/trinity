# Bản TS theo tệp sở hữu (T01)

Trong giai đoạn lai, mỗi job nền chỉ có một chủ (`rust` hoặc `node`) ghi trong tệp `TRINITY_OWNERSHIP_FILE`
(định dạng và bộ đọc phía Rust: `server/crates/trinity-kernel/src/ownership.rs`, PLAN 4.14).

Phía Node (`packages/rbac-nest/src/ownership.ts`):

- Đọc lại tệp ở **đầu mỗi lượt tick** và so **nội dung** (tệp nhỏ; không dựa vào mtime/kích thước/inode). Job ghi `rust`
  thì Node bỏ lượt (lượt đang chạy dở chạy nốt); không ghi hoặc ghi `node` thì Node chạy.
- Phạm vi: mọi timer qua `tenantTimerTick` (tham số `jobName`, 11 job của `cronRegistry`), `@Cron` của
  `notification.scheduled`, migrate nền lúc boot (`migrate: rust` thì Node không chạy `migrateAllCompanies`), và mọi
  đường vào tay của ba job có `kick`: `kickIfDue`/`kick`/`runDue` của `social-posts` (`social.publish`),
  `facebook-flows` (`facebook.flows`), `facebook-broadcasts` (`facebook.broadcasts`), nên controller tick cũng nhả.
- Luật kiểm như bộ đọc Rust: khoá lạ hoặc trùng ở mọi cấp, chủ khác `rust|node`, tên job có khoảng trắng đầu/cuối, route
  đủ `prefix` hợp lệ, `methods` hợp lệ (GET gồm HEAD), `owner`, và không xung đột tiền tố + phương thức. Tệp sai là hỏng cả tệp.
- Tệp hỏng giữa chừng: giữ bảng đang dùng, ghi lỗi một lần cho mỗi phiên bản tệp. Đã đặt `TRINITY_OWNERSHIP_FILE` mà tệp
  hỏng hoặc thiếu **lúc khởi động**: monolith từ chối khởi động (`assertOwnershipLoadable` trong `configureApp`); nếu vẫn
  chạy thì Node bỏ mọi job và migrate cho tới khi tệp hợp lệ, không rơi về "mọi thứ thuộc Node" (sẽ chạy trùng với Rust).
- Không có khoá chéo tiến trình ở Node: hai bên cùng đọc một tệp nên mỗi job chỉ một bên chạy.
