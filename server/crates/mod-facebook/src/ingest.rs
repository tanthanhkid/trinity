//! Xử lý sự kiện webhook của MỘT công ty (M47b): tin Messenger vào ([`messenger`]) và Lead Ads ([`leads`]). Là bản cài của
//! [`crate::webhook::EntryProcessor`] mà M47a để sẵn; `facebook-webhook.service.ts` (`processEntries`) là nguồn.
//!
//! Quy tắc chung:
//! - Tin nhắn: lỗi của MỘT tin được ghi log và bỏ qua (`safe`), không làm hỏng cả lô (Meta sẽ gửi lại cả lô nếu 5xx). Idempotent theo
//!   `mid` (ràng buộc unique `facebook_messages_mid_key`).
//! - Lead: lỗi tạm của Graph được ném ra ⇒ route trả 5xx ⇒ Meta gửi lại; idempotent theo `leadgen_id`.
//! - Không giữ kết nối pool khi gọi Graph và không bao giờ giữ hai kết nối cùng lúc.
//!
//! Chưa có (việc của M48/M49): link/QR mở chat (`ingestReferral`), kịch bản nhắn tin (`flows.handleEvent`), bình luận (`feed`).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use trinity_db::pg_error::app_error;
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_kernel::error::AppError;

use crate::config::Env;
use crate::graph::GraphClient;
use crate::webhook::{BoxFut, EntryProcessor};

pub use crate::leads::LeadResult;

/// Dựng client Graph cho một công ty (gắn `observer` của `ChannelGuard` công ty đó).
pub type GraphFactory = Arc<dyn Fn(CompanyRef) -> GraphClient + Send + Sync>;

#[allow(clippy::needless_pass_by_value)]
pub(crate) fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

pub(crate) fn platform_db(d: trinity_db::DbError) -> AppError {
    AppError::internal(d)
}

/// Id dạng chuỗi không rỗng; số cũng nhận (id Meta đôi khi là số).
pub(crate) fn str_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// `s.slice(0, n)` của JS: tính theo đơn vị UTF-16.
pub(crate) fn utf16_prefix(s: &str, n: usize) -> String {
    crate::graph::utf16_prefix(s, n)
}

/// Bản cài [`EntryProcessor`] dùng Postgres thật và Graph thật.
pub struct FacebookIngest {
    pub db: Db,
    pub env: Env,
    pub graph_for: GraphFactory,
    /// Lần đồng bộ hội thoại gần nhất (mili giây) theo (công ty, id hội thoại): mỗi hội thoại tối đa một lần mỗi phút (M48).
    pub(crate) last_sync: Mutex<HashMap<(CompanyRef, i32), i64>>,
}

impl FacebookIngest {
    pub fn new(db: Db, env: Env, graph_for: GraphFactory) -> Self {
        Self {
            db,
            env,
            graph_for,
            last_sync: Mutex::new(HashMap::new()),
        }
    }

    /// Một kết nối đã gắn công ty cho MỘT bước DB; người gọi trả lại (drop) trước khi gọi Graph hoặc xin kết nối khác.
    pub(crate) async fn acquire(&self, company: CompanyRef) -> Result<TenantConn, AppError> {
        self.db
            .tenant(company)
            .await
            .map_err(platform_db)?
            .acquire()
            .await
            .map_err(platform_db)
    }

    /// `processEntries` cho các entry của một công ty (cờ gói `facebook_page` đã kiểm ở `Receiver`). Trả số sự kiện đã xử lý.
    pub async fn process_entries(&self, company: CompanyRef, entries: &[Value]) -> Result<usize, AppError> {
        let mut n = 0;
        for entry in entries {
            let Some(page_id) = str_of(entry.get("id")) else {
                continue;
            };
            if let Some(events) = entry.get("messaging").and_then(Value::as_array) {
                for ev in events {
                    match self.ingest_message(company, &page_id, ev).await {
                        Ok(true) => n += 1,
                        Ok(false) => {}
                        // Lỗi DB của 1 tin không được làm hỏng cả lô (và gây Meta gửi lại tin đã xử lý).
                        Err(e) => tracing::error!("Xử lý sự kiện Facebook lỗi: {e}"),
                    }
                }
            }
            if let Some(changes) = entry.get("changes").and_then(Value::as_array) {
                for ch in changes {
                    let field = ch.get("field").and_then(Value::as_str);
                    let Some(value) = ch.get("value").filter(|v| !v.is_null()) else {
                        continue;
                    };
                    // `feed` (bình luận) thuộc M49: bỏ qua ở đây.
                    if field != Some("leadgen") {
                        continue;
                    }
                    // Lỗi tạm của Graph được ném ra ⇒ route trả 5xx ⇒ Meta gửi lại.
                    let r = self.handle_lead(company, &page_id, value).await?;
                    if matches!(r, LeadResult::Created | LeadResult::Duplicate) {
                        n += 1;
                    }
                }
            }
        }
        Ok(n)
    }
}

impl EntryProcessor for FacebookIngest {
    fn process<'a>(&'a self, company: CompanyRef, entries: &'a [Value]) -> BoxFut<'a, Result<usize, AppError>> {
        Box::pin(async move { self.process_entries(company, entries).await })
    }
}
