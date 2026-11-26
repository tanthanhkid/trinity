//! Module notify (M32), chuyển từ `services/notification`: thông báo (`/notifications`), mẫu (`/templates`), sự kiện
//! nội bộ (`/events`), phân phối theo kênh và job hẹn giờ `notification.scheduled`.
//!
//! Hàm nghiệp vụ nhận `&TenantDb` (lấy kết nối cho từng câu lệnh, KHÔNG giữ kết nối khi gọi HTTP ra ngoài) và trả
//! `AppError` của K05. Route và quyền (`AuthOnly` cho `/notifications` của chính mình, `settings.integrations` cho gửi tay
//! và `/templates`, `Internal` cho `/events`) nối vào router khi K14/K11 có; xem mô tả PR. Phần tạo thông báo từ module
//! khác dùng `trinity_db::outbox::create_notification` (K36), không nằm ở đây.

pub mod delivery;
pub mod events;
pub mod helpers;
pub mod jobs;
pub mod notifications;
pub mod templates;
