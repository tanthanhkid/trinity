//! M35: nguồn webhook vào. 7 endpoint: quản trị nguồn (6 route dưới `/integrations/webhooks/inbound-sources`, [`sources`]) và nhận
//! khách `POST /hooks/in/:token` ([`receive`]). Chưa nối route (như M34): các hàm ở đây là thân của 7 route; tầng route lo cờ
//! (`webhooks_enabled` tắt ⇒ 404), quyền (`integrations.webhooks`; tạo/sửa/tạo lại token THÊM `contacts.create`), phạm vi
//! `contacts.transfer` ([`sources::Actor`]), chọn công ty từ `?cid=` của đường công khai, `rawBody` và `X-Trinity-Signature`.
//!
//! Phản hồi CÔNG KHAI luôn là `200 {"status":"accepted","contact_id":null}` cho số mới, số đã có hay gửi lại cùng
//! `external_id`: người ngoài không dò được SĐT nào đã là khách. Nhật ký nội bộ (`integration_audit_logs`, kênh `webhook_in`)
//! vẫn ghi kết quả thật, không ghi body hay SĐT.

pub mod payload;
pub mod receive;
pub mod sources;
pub mod token;
