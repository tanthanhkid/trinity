//! Việc phụ sau khi ghi khách hàng (`mod_contacts::routes::Hooks`): xoá cache Tổng quan, dọn bản ghi mẫu sau khách thật đầu
//! tiên, đồng bộ thẻ @ của `reminder_notes` và đẩy socket nội bộ cho thông báo "được giao thương vụ". Mỗi việc chỉ ghi log
//! khi lỗi, không làm hỏng việc chính (đã commit).

use std::sync::{Arc, OnceLock};

use mod_contacts::routes::{HookFuture, Hooks};
use mod_custom::refs::{Ref, RefType};
use mod_reports::cache::DASHBOARD_PREFIX;
use trinity_db::outbox::CreatedNotification;
use trinity_db::{CompanyRef, Db};
use trinity_http::router::CurrentUser;
use trinity_rbac::ScopeService;
use trinity_realtime::{NotifSocket, NotificationPayload};

pub struct ContactsHooks {
    pub db: Db,
    pub scopes: ScopeService,
    /// Bộ nhớ đệm số liệu Tổng quan (cùng bản mà router báo cáo đọc).
    pub reports: Arc<mod_reports::Ctx>,
    /// Ngữ cảnh module dựng sẵn (dọn mẫu).
    pub setup: Arc<mod_setup::Ctx>,
    /// Socket `/notif-ws`: điền sau khi dựng xong (router mount trước socket); chưa có ⇒ không đẩy.
    pub socket: Arc<OnceLock<NotifSocket>>,
}

/// `invalidatePrefix('dashboard:')`: xoá ở tiến trình này và phát `NOTIFY cache` để tiến trình khác xoá theo.
pub async fn invalidate_dashboard(db: &Db, reports: &mod_reports::Ctx, company: CompanyRef) {
    let conn = async {
        let tenant = db.tenant(company).await.map_err(|e| e.to_string())?;
        tenant.acquire().await.map_err(|e| e.to_string())
    }
    .await;
    match conn {
        Ok(mut conn) => {
            if let Err(e) = reports.cache.invalidate_prefix(&mut conn, company, DASHBOARD_PREFIX).await {
                tracing::warn!("xoá cache Tổng quan lỗi: {e}");
            }
        }
        Err(e) => tracing::warn!("xoá cache Tổng quan: không lấy được kết nối: {e}"),
    }
}

impl ContactsHooks {
    /// Đẩy `notification:new` + số chưa đọc tới socket của tiến trình này (tiến trình khác nhận qua `NOTIFY bell`).
    async fn push(&self, company: CompanyRef, items: &[CreatedNotification]) {
        let Some(socket) = self.socket.get() else {
            return;
        };
        if items.is_empty() {
            return;
        }
        let ids: Vec<i32> = items.iter().map(|n| n.id).collect();
        let times: Vec<(i32, String)> = {
            let loaded = async {
                let tenant = self.db.tenant(company).await.map_err(|e| e.to_string())?;
                let mut conn = tenant.acquire().await.map_err(|e| e.to_string())?;
                sqlx::query_as::<_, (i32, String)>(
                    "SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
                     FROM notification_logs WHERE id = ANY($1)",
                )
                .bind(&ids)
                .fetch_all(&mut *conn)
                .await
                .map_err(|e| e.to_string())
            }
            .await;
            loaded.unwrap_or_else(|e| {
                tracing::warn!("đọc thời điểm thông báo lỗi: {e}");
                Vec::new()
            })
        };
        for n in items {
            let created_at = times
                .iter()
                .find(|r| r.0 == n.id)
                .map(|r| r.1.clone())
                .unwrap_or_default();
            let payload = NotificationPayload {
                id: Some(n.id),
                title: n.title.clone(),
                body: n.body.clone(),
                channel: "in_app".to_owned(),
                event_type: Some(n.event_type.clone()),
                action_url: n.action_url.clone(),
                is_read: false,
                created_at,
            };
            socket
                .push_local(&self.db, i64::from(company.id()), i64::from(n.recipient_id), &payload)
                .await;
        }
    }
}

impl Hooks for ContactsHooks {
    fn after_create<'a>(&'a self, company: CompanyRef, notifications: &'a [CreatedNotification]) -> HookFuture<'a> {
        Box::pin(async move {
            invalidate_dashboard(&self.db, &self.reports, company).await;
            mod_setup::samples::purge_if_real(&self.setup, company).await;
            self.push(company, notifications).await;
        })
    }

    fn after_remove_or_restore(&self, company: CompanyRef) -> HookFuture<'_> {
        Box::pin(async move {
            invalidate_dashboard(&self.db, &self.reports, company).await;
        })
    }

    fn after_update_notes<'a>(
        &'a self,
        company: CompanyRef,
        user: &'a CurrentUser,
        contact_id: i32,
        reminder_notes: Option<&'a str>,
    ) -> HookFuture<'a> {
        Box::pin(async move {
            let ctx = mod_custom::Ctx {
                db: self.db.clone(),
                scopes: self.scopes.clone(),
            };
            let actor = mod_custom::Actor {
                user_id: user.user.user_id,
                company,
                grants: user.grants.grants.clone(),
                is_admin: user.grants.is_admin,
            };
            let source = Ref {
                ty: RefType::Contact,
                id: contact_id,
            };
            mod_custom::refs::sync_mentions(&ctx, &actor, source, "reminder_notes", reminder_notes).await;
        })
    }
}
