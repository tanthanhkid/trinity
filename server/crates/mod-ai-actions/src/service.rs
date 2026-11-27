//! Logic của đề xuất AI (`ai-actions.service.ts`, `ai-action-view.ts`). Mọi truy vấn theo người dùng đã xác thực: đề xuất của
//! người khác ⇒ 404. Ghi phụ (nhật ký) lỗi chỉ ghi log, không làm hỏng việc chính; không giữ kết nối khi chạy tool.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, TenantConn};
use trinity_integrations::audit::{self, AuditEntry, AuditStatus, Channel};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vn_time::js_iso_string;
use trinity_rbac::can;

use crate::{ActionUser, AiActionsCtx, REQUIRE_APPROVAL_KEY};

type R<T> = Result<T, AppError>;

/// Quá ngần này mà vẫn `approved` và chưa có `result` ⇒ tiến trình đã chết giữa chừng (khởi động lại/hết bộ nhớ).
const EXECUTION_STALE: Duration = Duration::minutes(5);
/// Hạn một lần thực thi (phải < `EXECUTION_STALE`); [`crate::AiActionsCtx::exec_timeout`] mặc định.
pub const DEFAULT_EXEC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4 * 60);
const STALE_EXECUTION_ERROR: &str = "Không rõ kết quả: máy chủ khởi động lại khi đang thực hiện. Hãy kiểm tra dữ liệu thủ công trước khi nhờ AI đề xuất lại.";
const STATUSES: [&str; 6] = ["pending", "approved", "executed", "rejected", "expired", "failed"];
const NOT_FOUND: &str = "Không tìm thấy đề xuất";

fn db(e: sqlx::Error) -> AppError {
    trinity_db::pg_error::app_error(&e)
}

fn bad(msg: &str) -> AppError {
    HttpError::bad_request(msg).into()
}

#[derive(Clone, sqlx::FromRow)]
struct Draft {
    id: i32,
    client_id: String,
    tool: String,
    params: Value,
    summary: String,
    details: Value,
    status: String,
    result: Option<Value>,
    error: Option<String>,
    impact: Option<Value>,
    created_at: DateTime<Utc>,
    decided_at: Option<DateTime<Utc>>,
    expires_at: DateTime<Utc>,
}

const COLS: &str =
    "id, client_id, tool, params, summary, details, status, result, error, impact, created_at, decided_at, expires_at";

/// Trạng thái hiệu lực (không phụ thuộc job): `pending` quá hạn ⇒ `expired`; `approved` chưa có `result` ⇒ `executing` trong cửa
/// sổ ngắn, quá cửa sổ ⇒ `failed` (kết quả không rõ).
fn effective_status(d: &Draft, now: DateTime<Utc>) -> &str {
    if d.status == "pending" && d.expires_at <= now {
        return "expired";
    }
    if d.status == "approved"
        && d.result.is_none()
        && let Some(at) = d.decided_at
    {
        return if now - at > EXECUTION_STALE {
            "failed"
        } else {
            "executing"
        };
    }
    &d.status
}

fn state_message(d: &Draft, now: DateTime<Utc>) -> &'static str {
    match effective_status(d, now) {
        "pending" => "Đề xuất đang được xử lý",
        "executing" => "Đề xuất đang được thực hiện (đã duyệt trước đó)",
        "approved" => "Đề xuất này đã được duyệt trước đó",
        "executed" => "Thao tác này đã được thực hiện",
        "rejected" => "Đề xuất này đã bị từ chối",
        "expired" => "Đề xuất đã hết hạn (quá 24 giờ) — hãy nhờ AI tạo lại",
        _ => "Đề xuất này đã được thử thực hiện nhưng thất bại — hãy nhờ AI tạo lại",
    }
}

/// Cắt theo đơn vị UTF-16 rồi thêm `…` như `shown()` của bản Node, sau khi che SĐT.
fn shown(s: &str, max: usize) -> String {
    let t = mod_mcp::ai_output::mask_phones_in_text(s);
    if t.encode_utf16().count() > max {
        format!("{}…", mod_mcp::ai_output::slice16(&t, max))
    } else {
        t
    }
}

/// Dòng chi tiết hợp lệ (`{label, value}` đều là chuỗi), tối đa 20.
fn details(v: &Value) -> Value {
    let Some(a) = v.as_array() else { return json!([]) };
    Value::Array(
        a.iter()
            .filter(|x| x.get("label").is_some_and(Value::is_string) && x.get("value").is_some_and(Value::is_string))
            .take(20)
            .cloned()
            .collect(),
    )
}

impl AiActionsCtx {
    async fn conn(&self, company: CompanyRef) -> R<TenantConn> {
        let t = self.db.tenant(company).await.map_err(AppError::internal)?;
        t.acquire().await.map_err(AppError::internal)
    }

    /// Dạng trả ra API/web. KHÔNG BAO GIỜ trả `params` thô (có thể chứa SĐT đầy đủ): chỉ `summary`/`details` đã che.
    fn view(&self, d: &Draft, client_name: Option<&str>, now: DateTime<Utc>) -> Value {
        let status = effective_status(d, now);
        let label = self.executor.info(&d.tool).map_or_else(|| d.tool.clone(), |i| i.label);
        let error = match &d.error {
            Some(e) if !e.is_empty() => json!(mod_mcp::ai_output::mask_phones_in_text(e)),
            _ if status == "failed" && d.status == "approved" => json!(STALE_EXECUTION_ERROR),
            _ => Value::Null,
        };
        json!({
            "id": d.id, "tool": d.tool, "tool_label": label, "client_name": client_name,
            "summary": d.summary, "details": details(&d.details), "status": status,
            "result": d.result.clone().unwrap_or(Value::Null), "error": error,
            "created_at": js_iso_string(d.created_at),
            "decided_at": d.decided_at.map_or(Value::Null, |t| json!(js_iso_string(t))),
            "expires_at": js_iso_string(d.expires_at),
            "impact": d.impact.clone().unwrap_or(Value::Null),
        })
    }

    /// Tên ứng dụng AI theo `client_id` (sổ client chung ở công ty 1).
    async fn client_names(&self, drafts: &[Draft]) -> R<HashMap<String, String>> {
        let mut ids: Vec<&str> = drafts.iter().map(|d| d.client_id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut c = self.conn(CompanyRef::DEFAULT).await?;
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT client_id, name FROM oauth_clients WHERE client_id = ANY($1)")
                .bind(&ids)
                .fetch_all(&mut *c)
                .await
                .map_err(db)?;
        Ok(rows.into_iter().collect())
    }

    async fn own(&self, company: CompanyRef, user: i32, id: i32) -> R<Draft> {
        let mut c = self.conn(company).await?;
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {COLS} FROM ai_action_drafts WHERE id = $1 AND user_id = $2"
        )))
        .bind(id)
        .bind(user)
        .fetch_optional(&mut *c)
        .await
        .map_err(db)?
        .ok_or_else(|| HttpError::not_found(NOT_FOUND).into())
    }

    /// Ghi nhật ký tích hợp kênh `mcp`; lỗi không làm hỏng việc chính.
    async fn audit_decision(
        &self,
        company: CompanyRef,
        action: &str,
        status: AuditStatus,
        d: &Draft,
        user: i32,
        error: Option<&str>,
    ) {
        let mut e = AuditEntry::new(Channel::Mcp, action, status);
        e.client_id = Some(d.client_id.clone());
        e.user_id = Some(user);
        e.resource = Some("ai_action_draft".to_owned());
        e.resource_id = Some(d.id.to_string());
        e.error = error.map(str::to_owned);
        e.metadata = Some(json!({ "tool": d.tool, "decided_by": user, "summary": d.summary }));
        if let Ok(mut c) = self.conn(company).await {
            audit::log(&mut c, &e).await;
        }
    }

    /// `GET /ai-actions`. `status` đã kiểm; `cursor` ⇒ chỉ dòng có `id < cursor`.
    pub async fn list(
        &self,
        company: CompanyRef,
        user: i32,
        status: Option<&str>,
        cursor: Option<i32>,
        limit: i64,
    ) -> R<Value> {
        let now = Utc::now();
        let rows: Vec<Draft> = {
            let mut c = self.conn(company).await?;
            let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new(format!(
                "SELECT {COLS} FROM ai_action_drafts WHERE user_id = "
            ));
            qb.push_bind(user);
            if let Some(cur) = cursor {
                qb.push(" AND id < ").push_bind(cur);
            }
            match status {
                Some("pending") => {
                    qb.push(" AND status = 'pending' AND expires_at > ").push_bind(now);
                }
                Some("expired") => {
                    qb.push(" AND (status = 'expired' OR (status = 'pending' AND expires_at <= ")
                        .push_bind(now)
                        .push("))");
                }
                Some(s) => {
                    qb.push(" AND status = ").push_bind(s.to_owned());
                }
                None => {}
            }
            qb.push(" ORDER BY id DESC LIMIT ").push_bind(limit + 1);
            qb.build_query_as().fetch_all(&mut *c).await.map_err(db)?
        };
        let more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
        let page: Vec<Draft> = rows.into_iter().take(usize::try_from(limit).unwrap_or(50)).collect();
        let names = self.client_names(&page).await?;
        let data: Vec<Value> = page
            .iter()
            .map(|d| self.view(d, names.get(&d.client_id).map(String::as_str), now))
            .collect();
        let next = if more { page.last().map(|d| d.id) } else { None };
        Ok(json!({ "data": data, "next_cursor": next }))
    }

    pub async fn get(&self, company: CompanyRef, user: i32, id: i32) -> R<Value> {
        let d = self.own(company, user, id).await?;
        let names = self.client_names(std::slice::from_ref(&d)).await?;
        Ok(self.view(&d, names.get(&d.client_id).map(String::as_str), Utc::now()))
    }

    pub async fn pending_count(&self, company: CompanyRef, user: i32) -> R<i64> {
        let now = Utc::now();
        let mut c = self.conn(company).await?;
        sqlx::query_scalar(
            "SELECT count(*) FROM ai_action_drafts WHERE user_id = $1 AND status = 'pending' AND expires_at > $2",
        )
        .bind(user)
        .bind(now)
        .fetch_one(&mut *c)
        .await
        .map_err(db)
    }

    /// "Yêu cầu duyệt thay đổi do AI": mặc định TẮT. Lỗi đọc ⇒ coi là BẬT (thà chờ duyệt còn hơn ghi nhầm).
    pub async fn requires_approval(&self, company: CompanyRef) -> bool {
        let res = async {
            let mut c = self.conn(company).await.map_err(|e| format!("{e:?}"))?;
            sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = $1")
                .bind(REQUIRE_APPROVAL_KEY)
                .fetch_optional(&mut *c)
                .await
                .map_err(|e| e.to_string())
        }
        .await;
        match res {
            Ok(v) => v.as_deref() == Some("true"),
            Err(e) => {
                tracing::error!("Đọc cài đặt duyệt AI lỗi, dùng chế độ chờ duyệt: {e}");
                true
            }
        }
    }

    pub async fn set_require_approval(&self, company: CompanyRef, value: bool, user: i32) -> R<Value> {
        {
            let mut c = self.conn(company).await?;
            sqlx::query(
                "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now()) \
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()",
            )
            .bind(REQUIRE_APPROVAL_KEY)
            .bind(value.to_string())
            .bind(user)
            .execute(&mut *c)
            .await
            .map_err(db)?;
        }
        let mut e = AuditEntry::new(Channel::Mcp, "ai_action.setting", AuditStatus::Ok);
        e.user_id = Some(user);
        e.resource = Some("setting".to_owned());
        e.resource_id = Some(REQUIRE_APPROVAL_KEY.to_owned());
        e.metadata = Some(json!({ "require_approval": value }));
        if let Ok(mut c) = self.conn(company).await {
            audit::log(&mut c, &e).await;
        }
        Ok(json!({ "require_approval": value }))
    }

    pub async fn reject(&self, company: CompanyRef, user: i32, id: i32) -> R<Value> {
        let now = Utc::now();
        let claimed = {
            let mut c = self.conn(company).await?;
            sqlx::query(
                "UPDATE ai_action_drafts SET status = 'rejected', decided_at = $3 \
                 WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > $3",
            )
            .bind(id)
            .bind(user)
            .bind(now)
            .execute(&mut *c)
            .await
            .map_err(db)?
            .rows_affected()
        };
        let d = self.own(company, user, id).await?;
        if claimed != 1 {
            // Hết hạn mà chưa được ai xử lý: đánh dấu `expired` như lúc duyệt, không cho từ chối "vượt hạn".
            if d.status == "pending" {
                self.mark_expired(company, id, now).await;
            }
            return Err(HttpError::conflict(state_message(&d, now)).into());
        }
        self.audit_decision(company, "ai_action.reject", AuditStatus::Ok, &d, user, None)
            .await;
        self.get(company, user, id).await
    }

    /// `pending` quá hạn ⇒ `expired`. Lỗi chỉ ghi log (đã trả 409, job sẽ dọn).
    async fn mark_expired(&self, company: CompanyRef, id: i32, now: DateTime<Utc>) {
        match self.conn(company).await {
            Ok(mut c) => {
                if let Err(e) = sqlx::query(
                    "UPDATE ai_action_drafts SET status = 'expired', decided_at = $2 \
                     WHERE id = $1 AND status = 'pending' AND expires_at <= $2",
                )
                .bind(id)
                .bind(now)
                .execute(&mut *c)
                .await
                {
                    tracing::warn!("Đánh dấu đề xuất AI #{id} hết hạn lỗi: {e}");
                }
            }
            Err(e) => tracing::warn!("Đánh dấu đề xuất AI #{id} hết hạn: không lấy được kết nối: {e:?}"),
        }
    }

    /// DUYỆT: chạy qua ĐÚNG service nghiệp vụ với người duyệt (= chủ đề xuất). "Nhận" bằng UPDATE nguyên tử `pending → approved`
    /// (kèm kiểm hạn) TRƯỚC khi chạy nên chỉ một request thắng, thực thi tối đa MỘT lần; quyền kiểm lại ở đây.
    pub async fn approve(&self, user: &ActionUser, id: i32, confirm_text: Option<&str>) -> R<Value> {
        let company = user.company;
        let now = Utc::now();
        let pre = self.own(company, user.user_id, id).await?;
        // Trạng thái TRƯỚC (409 đã duyệt/từ chối/hết hạn), rồi mới đến xác nhận tên bảng: đề xuất đã xử lý không đòi gõ lại.
        if pre.status != "pending" || pre.expires_at <= now {
            if pre.status == "pending" {
                self.mark_expired(company, id, now).await;
            }
            return Err(HttpError::conflict(state_message(&pre, now)).into());
        }
        // Đổi cấu trúc có bản ghi bị ảnh hưởng ⇒ phải gõ ĐÚNG tên bảng (kiểm trước khi nhận duyệt).
        let need = pre
            .impact
            .as_ref()
            .and_then(|i| i.get("confirm_label"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        if let Some(need) = need
            && norm(confirm_text.unwrap_or("")) != norm(need)
        {
            return Err(bad(&format!(
                "Đề xuất này ảnh hưởng tới dữ liệu đang có — hãy gõ đúng tên bảng “{need}” để xác nhận."
            )));
        }
        let claimed = {
            let mut c = self.conn(company).await?;
            sqlx::query(
                "UPDATE ai_action_drafts SET status = 'approved', decided_at = $3 \
                 WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > $3",
            )
            .bind(id)
            .bind(user.user_id)
            .bind(now)
            .execute(&mut *c)
            .await
            .map_err(db)?
            .rows_affected()
        };
        let row = self.own(company, user.user_id, id).await?;
        if claimed != 1 {
            if row.status == "pending" {
                self.mark_expired(company, id, now).await;
            }
            return Err(HttpError::conflict(state_message(&row, now)).into());
        }
        let result = match self.run(&row, user).await {
            Ok(r) => r,
            Err(err) => {
                self.fail(&row, user, &err).await;
                return Err(to_http(err));
            }
        };
        // Đã thực thi xong: ghi kết quả có thử lại; lỗi ghi `result`/nhật ký KHÔNG được biến thành "thất bại" (thao tác đã xảy ra).
        self.record_result(company, id, &result).await;
        self.audit_decision(company, "ai_action.approve", AuditStatus::Ok, &row, user.user_id, None)
            .await;
        // Trả từ dữ liệu đã có: đọc lại lỗi cũng không biến một thao tác đã chạy thành 500 (AI sẽ đề xuất lại ⇒ ghi hai lần).
        let mut done = row;
        done.result = Some(result);
        let names = self.client_names(std::slice::from_ref(&done)).await.unwrap_or_default();
        Ok(self.view(&done, names.get(&done.client_id).map(String::as_str), Utc::now()))
    }

    /// Ghi `result` khi thao tác đã chạy xong. Thử lại vài lần (lấy kết nối/ghi lỗi tạm thời); chỉ ghi khi dòng còn `approved`
    /// (đã bị đánh `failed` thì không đè). Hết lần thử: ghi log kèm kết quả để người vận hành đối chiếu.
    async fn record_result(&self, company: CompanyRef, id: i32, result: &Value) {
        let text = trinity_kernel::json::js_json(result);
        for (i, wait) in [0u64, 100, 300, 900].into_iter().enumerate() {
            if wait > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
            }
            let mut c = match self.conn(company).await {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(
                        "Ghi kết quả đề xuất #{id} (lần {}): không lấy được kết nối: {e:?}",
                        i + 1
                    );
                    continue;
                }
            };
            match sqlx::query(
                "UPDATE ai_action_drafts SET result = $2::text::jsonb WHERE id = $1 AND status = 'approved'",
            )
            .bind(id)
            .bind(&text)
            .execute(&mut *c)
            .await
            {
                Ok(r) if r.rows_affected() == 1 => return,
                Ok(_) => {
                    tracing::error!(
                        "Đề xuất #{id} đã không còn ở trạng thái approved khi ghi kết quả (đã bị đánh failed?): {text}"
                    );
                    return;
                }
                Err(e) => tracing::warn!("Ghi kết quả đề xuất #{id} (lần {}) lỗi: {e}", i + 1),
            }
        }
        tracing::error!("KHÔNG ghi được kết quả đề xuất #{id} sau nhiều lần thử; thao tác ĐÃ chạy, kết quả: {text}");
    }

    async fn run(&self, row: &Draft, user: &ActionUser) -> R<Value> {
        let Some(info) = self.executor.info(&row.tool) else {
            return Err(bad("Loại đề xuất không còn được hỗ trợ"));
        };
        if let Some(missing) = info
            .permissions
            .iter()
            .find(|p| !user.is_admin && !can(&user.grants, p, None))
        {
            return Err(HttpError::forbidden(format!(
                "Bạn không còn quyền thực hiện thao tác này (cần quyền {missing})"
            ))
            .into());
        }
        // Chụp cấu trúc TRƯỚC khi đổi để quay lui được; không chụp được thì KHÔNG đổi.
        if info.structure {
            self.executor
                .save_version(row.id, &row.tool, &row.summary, user)
                .await?;
        }
        // Hạn thực thi (`exec_timeout`): quá hạn thì dừng chờ, đề xuất thành `failed` với lý do "kết quả không rõ"
        // (thao tác có thể đã chạy một phần; AI/người duyệt phải kiểm lại thay vì tin là thất bại hẳn).
        match tokio::time::timeout(
            self.exec_timeout,
            self.executor.execute(&row.tool, &row.params, user, row.id),
        )
        .await
        {
            Ok(r) => r,
            Err(_) => Err(HttpError::new(504, MSG_QUA_HAN).into()),
        }
    }

    async fn fail(&self, row: &Draft, user: &ActionUser, err: &AppError) {
        let msg = shown(&err_message(err), 900);
        if !matches!(err, AppError::Http(_)) {
            tracing::error!("Duyệt đề xuất AI #{} lỗi: {err:?}", row.id);
        }
        if let Ok(mut c) = self.conn(user.company).await {
            let _ = sqlx::query("UPDATE ai_action_drafts SET status = 'failed', error = $2 WHERE id = $1")
                .bind(row.id)
                .bind(&msg)
                .execute(&mut *c)
                .await;
        }
        let denied = matches!(err, AppError::Http(h) if h.status() == 403 || h.status() == 404);
        let status = if denied {
            AuditStatus::Denied
        } else {
            AuditStatus::Error
        };
        self.audit_decision(user.company, "ai_action.approve", status, row, user.user_id, Some(&msg))
            .await;
    }
}

/// `norm()`: NFC không có sẵn nên chỉ cắt, gộp khoảng trắng và chữ thường (tên bảng nhập tay).
fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Lý do lưu vào đề xuất khi thực thi quá hạn (chỉ ghi DB; phản hồi HTTP vẫn là 500 chung, xem `to_http`).
const MSG_QUA_HAN: &str =
    "Thao tác quá hạn thực thi, kết quả không rõ — hãy kiểm tra lại dữ liệu trước khi đề xuất lại";

fn err_message(e: &AppError) -> String {
    match e {
        AppError::Http(h) if h.status() == 504 => MSG_QUA_HAN.to_owned(),
        AppError::Http(h) if h.status() < 500 => match h.body().message {
            trinity_kernel::error::Message::One(m) => m,
            trinity_kernel::error::Message::Many(ms) => ms.join("; "),
        },
        _ => "Lỗi hệ thống khi thực hiện đề xuất".to_owned(),
    }
}

/// Lỗi < 500 của dịch vụ nghiệp vụ trả nguyên; còn lại là 500 chung (đề xuất đã đánh dấu thất bại).
fn to_http(e: AppError) -> AppError {
    match e {
        AppError::Http(h) if h.status() < 500 => AppError::Http(h),
        _ => HttpError::nest(
            500,
            Some(
                "Không thực hiện được đề xuất do lỗi hệ thống. Đề xuất đã được đánh dấu thất bại."
                    .to_owned()
                    .into(),
            ),
        )
        .into(),
    }
}

pub struct Expired {
    pub expired: u64,
    pub stale: u64,
    pub purged: u64,
}

/// Job: đề xuất chờ quá hạn ⇒ `expired`; đã nhận duyệt mà không có kết quả quá 5 phút ⇒ `failed`; đã xong quá 90 ngày ⇒ xoá.
pub async fn expire_overdue(conn: &mut PgConnection, now: DateTime<Utc>) -> Result<Expired, sqlx::Error> {
    let expired = sqlx::query(
        "UPDATE ai_action_drafts SET status = 'expired', decided_at = $1 WHERE status = 'pending' AND expires_at <= $1",
    )
    .bind(now)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    let stale = sqlx::query("UPDATE ai_action_drafts SET status = 'failed', error = $2 WHERE status = 'approved' AND result IS NULL AND decided_at < $1")
        .bind(now - EXECUTION_STALE)
        .bind(STALE_EXECUTION_ERROR)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    let purged = sqlx::query("DELETE FROM ai_action_drafts WHERE status <> 'pending' AND created_at < $1")
        .bind(now - Duration::days(90))
        .execute(&mut *conn)
        .await?
        .rows_affected();
    Ok(Expired { expired, stale, purged })
}

pub fn status_ok(s: &str) -> bool {
    STATUSES.contains(&s)
}
