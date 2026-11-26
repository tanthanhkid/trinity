//! M33: nhật ký tích hợp, trạng thái cờ và hai job dọn của mô-đun `integrations` (bản Node:
//! `services/crm/src/integrations/integrations.controller.ts`, `integration-outbox-purge.service.ts`,
//! `oauth/oauth-purge.service.ts`, `packages/prisma/src/integrations/*`).
//!
//! Phạm vi: logic và truy vấn DB; chưa nối route (router/auth chưa có trên `main`). Hai endpoint cần nối sau:
//! `GET /integrations/status` (quyền `integrations.webhooks` HOẶC `integrations.ai_connect` HOẶC `integrations.ai_admin`,
//! luôn 200: [`status::status`]) và `GET /integrations/audit-logs` (quyền `integrations.ai_admin`; cả hai cờ tắt ⇒ 404;
//! [`audit::list`], trả `{ data, meta: { next_cursor } }`). Phần GHI outbox (`publish_integration_event`) thuộc K36.
//!
//! M34: [`webhooks`] (webhook ra: 10 route dưới `/integrations/webhooks`, dispatcher, worker, chữ ký, che SĐT).

pub mod audit;
pub mod purge;
pub mod status;
pub mod webhooks;

pub use audit::{AuditEntry, AuditQuery, AuditStatus, Channel};
pub use purge::{JOB_OAUTH_PURGE, JOB_OUTBOX_PURGE, oauth_purge_job, outbox_purge_job, purge_oauth, purge_outbox};
