//! `GET /contacts`: danh sách theo phạm vi `contacts.view`, hai kiểu phân trang (`ContactsService.findAll`).
//!
//! - **page** (`?page=N`): trả `meta.total` + `meta.pages`; `page * limit` không vượt [`MAX_PAGE_OFFSET`]; tổng đếm lấy từ
//!   [`CountCache`] (TTL 60 giây theo người gọi + điều kiện).
//! - **cursor** (mặc định): `meta.next_cursor` là id dòng cuối; không chỉ định sắp xếp thì luôn `id DESC`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::sync::{self, SyncError, SyncEvent};
use trinity_db::types::{JsonValue, Timestamp};
use trinity_db::{CompanyRef, Db};
use trinity_kernel::error::{AppError, HttpError};

use crate::filter::{ContactFilters, ContactWhere, resolve};
use crate::{Actor, Scopes, db, http};

/// OFFSET tối đa ở kiểu page: chặn quét sâu trên bảng lớn (`limit=50` cho tối đa 40 trang).
pub const MAX_PAGE_OFFSET: i64 = 2_000;
pub const DEFAULT_LIMIT: i64 = 50;
const COUNT_TTL: Duration = Duration::from_secs(60);
/// Tiền tố khoá cache đếm trong tin `cache` của `trinity_sync` (`COUNT_CACHE_KEY_PREFIX` của `ContactsService`).
pub const COUNT_PREFIX: &str = "crm:contacts:count:";

/// Query `GET /contacts` (đã qua K15: `limit` 1..200, `page` ≥ 1, `sort_by` ∈ created_at|full_name|id|lead_score…).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub cursor: Option<i32>,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub sort_by: Option<String>,
    #[serde(default)]
    pub sort_order: Option<String>,
    #[serde(flatten)]
    pub filters: ContactFilters,
}

/// Cache đếm tổng trong RAM của tiến trình (`ReadCache` của TS). `TRINITY_DISABLE_READ_CACHE=1` hoặc [`Self::disabled`]
/// ⇒ luôn đếm lại từ DB.
#[derive(Debug, Default)]
pub struct CountCache {
    disabled: bool,
    map: Mutex<HashMap<String, (Instant, i64)>>,
}

impl CountCache {
    pub fn new() -> Self {
        Self {
            disabled: std::env::var("TRINITY_DISABLE_READ_CACHE").is_ok_and(|v| v == "1"),
            map: Mutex::default(),
        }
    }

    pub fn disabled() -> Self {
        Self {
            disabled: true,
            map: Mutex::default(),
        }
    }

    fn get(&self, key: &str) -> Option<i64> {
        // Shadow (K28) bỏ qua cache: không đọc số cũ, không ghi số của lượt so sánh.
        if self.disabled || trinity_kernel::shadow::active() {
            return None;
        }
        let map = self.map.lock().ok()?;
        map.get(key).filter(|(at, _)| at.elapsed() < COUNT_TTL).map(|(_, n)| *n)
    }

    fn set(&self, key: String, total: i64) {
        if self.disabled || trinity_kernel::shadow::active() {
            return;
        }
        if let Ok(mut map) = self.map.lock() {
            if map.len() > 2_000 {
                map.retain(|_, (at, _)| at.elapsed() < COUNT_TTL);
            }
            map.insert(key, (Instant::now(), total));
        }
    }

    /// Xoá mọi số đếm (sau khi tạo, xoá, khôi phục khách làm đổi tổng).
    pub fn clear(&self) {
        if let Ok(mut map) = self.map.lock() {
            map.clear();
        }
    }

    /// `invalidatePrefix('crm:contacts:count:')` của TS: xoá ở tiến trình này và phát `NOTIFY cache` (trên `conn`) để tiến
    /// trình khác xoá theo. Gọi sau khi ghi đã commit.
    pub async fn invalidate(&self, conn: &mut PgConnection, company: CompanyRef) -> Result<(), SyncError> {
        self.clear();
        let mut f = Map::new();
        f.insert("p".into(), Value::from(COUNT_PREFIX));
        sync::publish_in_tx(conn, "cache", i64::from(company.id()), &f).await
    }

    /// Như [`Self::invalidate`] nhưng tự lấy kết nối; lỗi chỉ ghi log (việc chính đã commit). Cache RAM luôn được xoá trước.
    pub async fn invalidate_with(&self, db: &Db, company: CompanyRef) {
        self.clear();
        let sent = async {
            let tenant = db.tenant(company).await.map_err(|e| e.to_string())?;
            let mut conn = tenant.acquire().await.map_err(|e| e.to_string())?;
            self.invalidate(&mut conn, company).await.map_err(|e| e.to_string())
        }
        .await;
        if let Err(e) = sent {
            tracing::warn!("phát NOTIFY cache đếm khách lỗi: {e}");
        }
    }

    /// Xử lý một sự kiện từ `trinity_sync`: tin `cache` của tiến trình khác có tiền tố trùng/bao khoá đếm (`crm:contacts:count:`
    /// hoặc tiền tố ngắn hơn như `crm:`, rỗng) ⇒ xoá hết; khoá đếm chưa gắn công ty nên xoá của mọi công ty (an toàn, chỉ
    /// tốn một lần đếm lại). `Resync` (có thể đã lỡ tin) cũng xoá hết. Tin khác hoặc tiền tố khác (`dashboard:`) bỏ qua.
    pub fn on_sync_event(&self, ev: &SyncEvent) {
        match ev {
            SyncEvent::Resync => self.clear(),
            SyncEvent::Message(env) if env.kind == "cache" => {
                if let Some(p) = env.fields.get("p").and_then(Value::as_str)
                    && (COUNT_PREFIX.starts_with(p) || p.starts_with(COUNT_PREFIX))
                {
                    self.clear();
                }
            }
            SyncEvent::Message(_) => {}
        }
    }
}

/// Dòng danh sách: cột + các quan hệ nhỏ dựng sẵn thành JSON (đúng khoá của `CONTACT_LIST_SELECT`).
#[derive(Debug, sqlx::FromRow)]
struct Row {
    id: i32,
    phone: String,
    full_name: Option<String>,
    assigned_to: Option<i32>,
    team_id: Option<i32>,
    created_by_id: Option<i32>,
    created_at: Timestamp,
    lead_score: Option<i32>,
    lead_label: Option<String>,
    assignee_name: Option<String>,
    assignee_email: Option<String>,
    team_name: Option<String>,
    creator: Option<JsonValue>,
    source: Option<JsonValue>,
    stage: Option<JsonValue>,
    contact_status: Option<JsonValue>,
    latest_deal: Option<JsonValue>,
}

const SELECT: &str = "SELECT c.id, c.phone, c.full_name, c.assigned_to, c.team_id, c.created_by_id, c.created_at, c.lead_score, c.lead_label,
  au.full_name AS assignee_name, au.email AS assignee_email, t.name AS team_name,
  CASE WHEN cr.id IS NULL THEN NULL ELSE json_build_object('id', cr.id, 'full_name', cr.full_name,
    'role', (SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = cr.id ORDER BY ur.id LIMIT 1)) END AS creator,
  (SELECT json_build_object('id', o.id, 'value', o.value, 'label', o.label) FROM setting_options o WHERE o.id = c.source_id) AS source,
  (SELECT json_build_object('id', o.id, 'value', o.value, 'label', o.label) FROM setting_options o WHERE o.id = c.stage_id) AS stage,
  (SELECT json_build_object('id', o.id, 'value', o.value, 'label', o.label) FROM setting_options o WHERE o.id = c.contact_status_id) AS contact_status,
  (SELECT json_build_object('id', d.id, 'title', d.title, 'status', d.status, 'creator_name', dc.full_name, 'creator_email', dc.email)
     FROM deals d LEFT JOIN users dc ON dc.id = d.created_by WHERE d.contact_id = c.id ORDER BY d.created_at DESC LIMIT 1) AS latest_deal
FROM contacts c
LEFT JOIN users au ON au.id = c.assigned_to
LEFT JOIN users cr ON cr.id = c.created_by_id
LEFT JOIN teams t ON t.id = c.team_id";

/// Phần tử của `data`.
#[derive(Debug, Serialize)]
pub struct ContactListItem {
    pub id: i32,
    pub phone: Option<String>,
    pub full_name: Option<String>,
    pub source: Option<JsonValue>,
    pub stage_option: Option<JsonValue>,
    pub contact_status: Option<JsonValue>,
    pub stage: String,
    pub stage_source: &'static str,
    pub assigned_to: Option<i32>,
    pub team_id: Option<i32>,
    pub created_at: Timestamp,
    pub lead_score: Option<i32>,
    pub lead_label: Option<String>,
    pub assignee_name: Option<String>,
    pub assignee_email: Option<String>,
    pub team_name: Option<String>,
    pub creator: Option<JsonValue>,
    pub latest_deal: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Meta {
    Page {
        total: i64,
        page: i64,
        pages: i64,
        limit: i64,
        next_cursor: Option<i32>,
    },
    Cursor {
        next_cursor: Option<i32>,
    },
}

#[derive(Debug, Serialize)]
pub struct ContactList {
    pub data: Vec<ContactListItem>,
    pub meta: Meta,
}

/// Giai đoạn hiển thị (`deriveContactStage`): nhãn của `stage` đã chọn, không có thì "Mới".
pub(crate) fn derive_stage(stage: Option<&JsonValue>) -> (String, &'static str) {
    match stage
        .and_then(|s| s.0.get("label"))
        .and_then(|l| l.as_str())
        .filter(|l| !l.is_empty())
    {
        Some(l) => (l.to_owned(), "stage"),
        None => ("Mới".to_owned(), "default"),
    }
}

/// Khoá sắp xếp: biểu thức SQL theo bí danh bảng (`{}`) + chiều. `NULL` đứng cuối khi tăng, đầu khi giảm (mặc định của
/// Postgres/Prisma), trừ `lead_score` luôn cuối: viết thành cặp `(cột IS NULL)`, `cột` cùng chiều.
struct Key {
    expr: &'static str,
    desc: bool,
}

impl Key {
    fn sql(&self, alias: &str) -> String {
        self.expr.replace("{}", alias)
    }
}

fn order_keys(field: &str, desc: bool, id_only: bool) -> Vec<Key> {
    if id_only {
        return vec![Key {
            expr: "{}.id",
            desc: true,
        }];
    }
    let mut keys = match field {
        "lead_score" => vec![
            Key {
                expr: "({}.lead_score IS NULL)",
                desc: false,
            },
            Key {
                expr: "{}.lead_score",
                desc,
            },
        ],
        "full_name" => vec![
            Key {
                expr: "({}.full_name IS NULL)",
                desc,
            },
            Key {
                expr: "{}.full_name",
                desc,
            },
        ],
        "id" => vec![Key { expr: "{}.id", desc }],
        _ => vec![Key {
            expr: "{}.created_at",
            desc,
        }],
    };
    if field != "id" {
        keys.push(Key { expr: "{}.id", desc });
    }
    keys
}

fn push_order(qb: &mut QueryBuilder<Postgres>, keys: &[Key]) {
    qb.push(" ORDER BY ");
    for (i, k) in keys.iter().enumerate() {
        if i > 0 {
            qb.push(", ");
        }
        qb.push(k.sql("c")).push(if k.desc { " DESC" } else { " ASC" });
    }
}

/// ` AND (đứng sau dòng con trỏ)` theo thứ tự `keys`: so sánh từ điển, giá trị của dòng con trỏ lấy bằng truy vấn con.
/// Con trỏ không còn tồn tại ⇒ không dòng nào khớp (danh sách rỗng), như Prisma.
fn push_after_cursor(qb: &mut QueryBuilder<Postgres>, keys: &[Key], cursor: i32) {
    let cur = |k: &Key| format!("(SELECT {} FROM contacts cc WHERE cc.id = {})", k.sql("cc"), cursor);
    qb.push(" AND (");
    for (i, k) in keys.iter().enumerate() {
        if i > 0 {
            qb.push(" OR ");
        }
        qb.push("(");
        for prev in &keys[..i] {
            qb.push(prev.sql("c"))
                .push(" IS NOT DISTINCT FROM ")
                .push(cur(prev))
                .push(" AND ");
        }
        qb.push(k.sql("c"))
            .push(if k.desc { " < " } else { " > " })
            .push(cur(k))
            .push(")");
    }
    qb.push(")");
}

fn bad_request(msg: &str) -> AppError {
    http(HttpError::bad_request(msg))
}

/// `GET /contacts`.
pub async fn find_all(
    conn: &mut PgConnection,
    scopes: &Scopes,
    actor: &Actor,
    query: &ListQuery,
    cache: &CountCache,
) -> Result<ContactList, AppError> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, 200);
    let page_mode = query.page.is_some_and(|p| p >= 1);
    let wh: ContactWhere = resolve(&mut *conn, scopes, &query.filters).await?;

    let explicit = query.sort_by.as_deref().is_some_and(|s| !s.is_empty());
    let field = query
        .sort_by
        .as_deref()
        .filter(|f| matches!(*f, "full_name" | "id" | "lead_score"))
        .unwrap_or("created_at");
    let desc = query.sort_order.as_deref() == Some("desc") || !explicit;
    // Trang: sắp theo cột chọn rồi `id` cùng chiều (khớp index created_at + id). Con trỏ: luôn `id DESC` khi không chỉ định.
    let page_keys = order_keys(field, desc, false);
    let cursor_keys = order_keys(field, desc, !explicit);

    let mut total = 0;
    let mut page = 1;
    let mut pages = 1;
    let rows: Vec<Row> = if page_mode {
        page = query.page.unwrap_or(1);
        let skip = (page - 1) * limit;
        if skip + limit > MAX_PAGE_OFFSET {
            return Err(bad_request("Vượt giới hạn phân trang. Vui lòng thu hẹp bộ lọc."));
        }
        let key = format!("{}|{}|{}", actor.user_id, actor.is_admin, wh.cache_key());
        total = match cache.get(&key) {
            Some(n) => n,
            None => {
                let mut qb = QueryBuilder::<Postgres>::new("SELECT count(*) FROM contacts c WHERE ");
                wh.push_aliased(&mut qb);
                let n: i64 = qb.build_query_scalar().fetch_one(&mut *conn).await.map_err(db)?;
                cache.set(key, n);
                n
            }
        };
        pages = ((total + limit - 1) / limit).max(1);
        let mut qb = QueryBuilder::<Postgres>::new(SELECT);
        qb.push(" WHERE ");
        wh.push_aliased(&mut qb);
        push_order(&mut qb, &page_keys);
        qb.push(" LIMIT ").push_bind(limit).push(" OFFSET ").push_bind(skip);
        qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?
    } else {
        let mut qb = QueryBuilder::<Postgres>::new(SELECT);
        qb.push(" WHERE ");
        wh.push_aliased(&mut qb);
        if let Some(cur) = query.cursor {
            push_after_cursor(&mut qb, &cursor_keys, cur);
        }
        push_order(&mut qb, &cursor_keys);
        qb.push(" LIMIT ").push_bind(limit + 1);
        qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?
    };

    let has_more = !page_mode && i64::try_from(rows.len()).unwrap_or(0) > limit;
    let take = usize::try_from(limit).unwrap_or(50);
    let rows: Vec<Row> = if has_more {
        rows.into_iter().take(take).collect()
    } else {
        rows
    };
    let next_cursor = if has_more { rows.last().map(|r| r.id) } else { None };

    let masker = scopes.masker();
    let data = rows
        .into_iter()
        .map(|c| {
            let (stage, stage_source) = derive_stage(c.stage.as_ref());
            let owners = [c.assigned_to, c.created_by_id];
            ContactListItem {
                id: c.id,
                phone: masker.mask(&owners, Some(&c.phone)),
                full_name: c.full_name,
                source: c.source,
                stage_option: c.stage,
                contact_status: c.contact_status,
                stage,
                stage_source,
                assigned_to: c.assigned_to,
                team_id: c.team_id,
                created_at: c.created_at,
                lead_score: c.lead_score,
                lead_label: c.lead_label,
                assignee_name: c.assignee_name,
                assignee_email: c.assignee_email,
                team_name: c.team_name,
                creator: c.creator,
                latest_deal: c.latest_deal,
            }
        })
        .collect();
    let meta = if page_mode {
        Meta::Page {
            total,
            page,
            pages,
            limit,
            next_cursor: None,
        }
    } else {
        Meta::Cursor { next_cursor }
    };
    Ok(ContactList { data, meta })
}

#[cfg(test)]
mod sync_tests {
    use super::*;
    use trinity_db::sync::Envelope;

    fn msg(company: i64, kind: &str, p: Option<&str>) -> SyncEvent {
        let mut fields = Map::new();
        if let Some(p) = p {
            fields.insert("p".into(), Value::from(p));
        }
        SyncEvent::Message(Envelope {
            origin: "o".into(),
            kind: kind.into(),
            company,
            fields,
        })
    }

    fn filled() -> CountCache {
        let c = CountCache {
            disabled: false,
            map: Mutex::default(),
        };
        c.set("k".into(), 7);
        c
    }

    #[test]
    fn tin_cache_dem_khach_xoa_con_loai_khac_bo_qua() {
        for (kind, p, cleared) in [
            ("bell", Some(COUNT_PREFIX), false),
            ("cache", Some("dashboard:"), false),
            ("cache", Some("crm:contacts:co"), true),
            ("cache", Some(COUNT_PREFIX), true),
            ("cache", Some("crm:contacts:count:abc"), true),
            ("cache", Some(""), true),
            ("cache", None, false),
        ] {
            let c = filled();
            c.on_sync_event(&msg(1, kind, p));
            assert_eq!(c.get("k").is_none(), cleared, "{kind} {p:?}");
        }
        let c = filled();
        c.on_sync_event(&SyncEvent::Resync);
        assert!(c.get("k").is_none());
    }
}
