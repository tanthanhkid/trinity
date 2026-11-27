//! Nhắc việc treo: cấu hình ngưỡng, quét 4 loại việc treo gộp theo người phụ trách, thống kê của tôi + cấp dưới, và tổng hợp
//! gửi hằng ngày (job `stale-work.digest`, `POST /stale-work/run`).

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::PgConnection;
use trinity_db::TenantDb;
use trinity_db::outbox::{CreatedNotification, NewNotification, create_notification};
use trinity_kernel::error::AppError;
use trinity_kernel::vn_time::{to_vn, vn_date};

use crate::lead::NON_INTERACTION_ACTIONS;
use crate::{Features, db, put_setting, setting};
use chrono::Timelike;

const CONFIG_KEY: &str = "stale_work_config";
const LAST_DIGEST_KEY: &str = "stale_work_last_digest";
/// Lịch hẹn nhắc lỡ quá 30 ngày coi là đã bỏ, không nhắc mãi.
const REMINDER_LOOKBACK_DAYS: i64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct StaleWorkConfig {
    /// Khách có người phụ trách mà không có tương tác nào quá N ngày.
    pub contact_days: i64,
    /// Deal đang mở không đổi quá N ngày (và khách của deal cũng im lặng).
    pub deal_days: i64,
    /// Lịch hẹn nhắc coi là LỠ sau bấy nhiêu giờ kể từ giờ hẹn mà chưa có tương tác.
    pub reminder_grace_hours: i64,
    /// Giờ gửi tổng hợp sáng (0–23, giờ Việt Nam).
    pub digest_hour: i64,
}

pub const DEFAULT_CONFIG: StaleWorkConfig = StaleWorkConfig {
    contact_days: 7,
    deal_days: 14,
    reminder_grace_hours: 2,
    digest_hour: 8,
};

/// Số nguyên trong `[min, max]` (`Number.isInteger`: `7.0` cũng là nguyên), sai ⇒ mặc định.
fn int(v: Option<&Value>, min: i64, max: i64, def: i64) -> i64 {
    v.and_then(Value::as_f64)
        .filter(|n| n.fract() == 0.0 && *n >= min as f64 && *n <= max as f64)
        .map_or(def, |n| n as i64)
}

pub fn normalize_config(raw: &Value) -> StaleWorkConfig {
    let r = |k: &str| raw.as_object().and_then(|o| o.get(k));
    let d = DEFAULT_CONFIG;
    StaleWorkConfig {
        contact_days: int(r("contact_days"), 1, 365, d.contact_days),
        deal_days: int(r("deal_days"), 1, 365, d.deal_days),
        reminder_grace_hours: int(r("reminder_grace_hours"), 0, 168, d.reminder_grace_hours),
        digest_hour: int(r("digest_hour"), 0, 23, d.digest_hour),
    }
}

/// Giờ và ngày hiện tại theo múi giờ Việt Nam (UTC+7, không có DST): `(giờ, "YYYY-MM-DD")`.
pub fn vietnam_clock(now: DateTime<Utc>) -> (u32, String) {
    (to_vn(now).hour(), vn_date(now).format("%Y-%m-%d").to_string())
}

pub async fn get_config(conn: &mut PgConnection) -> Result<StaleWorkConfig, AppError> {
    Ok(match setting(conn, CONFIG_KEY).await? {
        Some(text) => serde_json::from_str::<Value>(&text).map_or(DEFAULT_CONFIG, |v| normalize_config(&v)),
        None => DEFAULT_CONFIG,
    })
}

/// `PUT /stale-work/config`: trường sai rơi về mặc định.
pub async fn save_config(conn: &mut PgConnection, raw: &Value, user: i32) -> Result<StaleWorkConfig, AppError> {
    let cfg = normalize_config(raw);
    let text = serde_json::to_string(&cfg).map_err(AppError::internal)?;
    put_setting(conn, CONFIG_KEY, &text, Some(user)).await?;
    Ok(cfg)
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
pub struct OwnerStats {
    pub silent_contacts: i64,
    pub silent_deals: i64,
    pub overdue_tasks: i64,
    pub missed_reminders: i64,
}

impl OwnerStats {
    pub fn total(&self) -> i64 {
        self.silent_contacts + self.silent_deals + self.overdue_tasks + self.missed_reminders
    }

    fn add(self, o: Self) -> Self {
        Self {
            silent_contacts: self.silent_contacts + o.silent_contacts,
            silent_deals: self.silent_deals + o.silent_deals,
            overdue_tasks: self.overdue_tasks + o.overdue_tasks,
            missed_reminders: self.missed_reminders + o.missed_reminders,
        }
    }
}

/// Câu mô tả cho thông báo: "5 khách im lặng quá 7 ngày, 2 việc quá hạn…".
pub fn describe(s: &OwnerStats, cfg: &StaleWorkConfig) -> String {
    let mut parts: Vec<String> = Vec::new();
    if s.silent_contacts > 0 {
        parts.push(format!(
            "{} khách im lặng quá {} ngày",
            s.silent_contacts, cfg.contact_days
        ));
    }
    if s.silent_deals > 0 {
        parts.push(format!("{} deal đứng yên quá {} ngày", s.silent_deals, cfg.deal_days));
    }
    if s.overdue_tasks > 0 {
        parts.push(format!("{} việc quá hạn", s.overdue_tasks));
    }
    if s.missed_reminders > 0 {
        parts.push(format!("{} lịch hẹn nhắc bị lỡ", s.missed_reminders));
    }
    parts.join(", ")
}

/// Quét 4 loại việc treo, gộp theo NGƯỜI PHỤ TRÁCH (mỗi loại một truy vấn gộp, không N+1). Chỉ tính việc đã có người phụ trách.
pub async fn scan(
    conn: &mut PgConnection,
    cfg: &StaleWorkConfig,
    now: DateTime<Utc>,
) -> Result<BTreeMap<i32, OwnerStats>, AppError> {
    let mut out: BTreeMap<i32, OwnerStats> = BTreeMap::new();
    let non: Vec<&str> = NON_INTERACTION_ACTIONS.to_vec();
    let contact_cut = now - Duration::days(cfg.contact_days);
    let deal_cut = now - Duration::days(cfg.deal_days);

    let contacts: Vec<(i32, i64)> = sqlx::query_as(
        "SELECT c.assigned_to, count(*) FROM contacts c
         WHERE c.deleted_at IS NULL AND c.assigned_to IS NOT NULL AND c.created_at < $1
           AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.contact_id = c.id AND a.created_at >= $1 AND a.action <> ALL($2))
         GROUP BY c.assigned_to",
    )
    .bind(contact_cut)
    .bind(&non)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let deals: Vec<(i32, i64)> = sqlx::query_as(
        "SELECT d.assigned_to, count(*) FROM deals d
         WHERE d.status = 'open' AND d.updated_at < $1
           AND (d.contact_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM activities a WHERE a.contact_id = d.contact_id AND a.created_at >= $1 AND a.action <> ALL($2)))
         GROUP BY d.assigned_to",
    )
    .bind(deal_cut)
    .bind(&non)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let tasks: Vec<(i32, i64)> = sqlx::query_as(
        "SELECT assignee_id, count(*) FROM kanban_cards
         WHERE deleted_at IS NULL AND completed_at IS NULL AND due_completed_at IS NULL AND due_at < $1 AND assignee_id IS NOT NULL
         GROUP BY assignee_id",
    )
    .bind(now)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let callbacks: Vec<(i32, i64)> = sqlx::query_as(
        "SELECT c.assigned_to, count(*) FROM contacts c
         WHERE c.deleted_at IS NULL AND c.assigned_to IS NOT NULL
           AND c.reminder_at < $1 AND c.reminder_at > $2
           AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.contact_id = c.id AND a.created_at >= c.reminder_at AND a.action <> ALL($3))
         GROUP BY c.assigned_to",
    )
    .bind(now - Duration::hours(cfg.reminder_grace_hours))
    .bind(now - Duration::days(REMINDER_LOOKBACK_DAYS))
    .bind(&non)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let mut bump = |owner: i32, n: i64, f: fn(&mut OwnerStats, i64)| {
        if n > 0 {
            f(out.entry(owner).or_default(), n);
        }
    };
    for (o, n) in contacts {
        bump(o, n, |s, n| s.silent_contacts += n);
    }
    for (o, n) in deals {
        bump(o, n, |s, n| s.silent_deals += n);
    }
    for (o, n) in tasks {
        bump(o, n, |s, n| s.overdue_tasks += n);
    }
    for (o, n) in callbacks {
        bump(o, n, |s, n| s.missed_reminders += n);
    }
    Ok(out)
}

/// Người dùng và quan hệ `manager_id` của cả công ty (kể cả người đã khoá, như `ScopeService.subtree`).
struct Tree {
    manager: HashMap<i32, Option<i32>>,
    active: HashSet<i32>,
    children: HashMap<i32, Vec<i32>>,
}

async fn load_tree(conn: &mut PgConnection) -> Result<Tree, AppError> {
    let rows: Vec<(i32, Option<i32>, bool)> =
        sqlx::query_as("SELECT id, manager_id, (status = 'active' AND deleted_at IS NULL) FROM users ORDER BY id")
            .fetch_all(conn)
            .await
            .map_err(db)?;
    let mut t = Tree {
        manager: HashMap::new(),
        active: HashSet::new(),
        children: HashMap::new(),
    };
    for (id, manager, active) in rows {
        t.manager.insert(id, manager);
        if active {
            t.active.insert(id);
        }
        if let Some(m) = manager {
            t.children.entry(m).or_default().push(id);
        }
    }
    Ok(t)
}

impl Tree {
    /// Cấp dưới trực tiếp và gián tiếp của `root` (không gồm chính họ); cây có vòng không treo.
    fn descendants(&self, root: i32) -> Vec<i32> {
        let mut seen: HashSet<i32> = HashSet::from([root]);
        let mut stack = vec![root];
        let mut out = Vec::new();
        while let Some(n) = stack.pop() {
            for c in self.children.get(&n).into_iter().flatten() {
                if seen.insert(*c) {
                    out.push(*c);
                    stack.push(*c);
                }
            }
        }
        out
    }

    fn team_stats(&self, manager: i32, stats: &BTreeMap<i32, OwnerStats>) -> OwnerStats {
        self.descendants(manager)
            .into_iter()
            .fold(OwnerStats::default(), |sum, id| {
                sum.add(stats.get(&id).copied().unwrap_or_default())
            })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Digest {
    pub recipient_id: i32,
    pub own: OwnerStats,
    /// Việc của cấp dưới (cây `manager_id`), KHÔNG gồm của chính người nhận.
    pub team: OwnerStats,
}

/// Người nhận = chủ việc + mọi cấp trên trực tiếp/gián tiếp của họ (chỉ user còn hoạt động; gặp cấp trên đã khoá thì dừng).
pub async fn build_digests(conn: &mut PgConnection, now: DateTime<Utc>) -> Result<Vec<Digest>, AppError> {
    let cfg = get_config(conn).await?;
    let stats = scan(conn, &cfg, now).await?;
    if stats.is_empty() {
        return Ok(Vec::new());
    }
    let tree = load_tree(conn).await?;
    let mut recipients: Vec<i32> = Vec::new();
    let add = |id: i32, v: &mut Vec<i32>| {
        if !v.contains(&id) {
            v.push(id);
        }
    };
    for owner in stats.keys() {
        if !tree.active.contains(owner) {
            continue;
        }
        add(*owner, &mut recipients);
        let mut seen: HashSet<i32> = HashSet::from([*owner]);
        let mut m = tree.manager.get(owner).copied().flatten();
        while let Some(cur) = m {
            if !seen.insert(cur) {
                break;
            }
            if tree.active.contains(&cur) {
                add(cur, &mut recipients);
                m = tree.manager.get(&cur).copied().flatten();
            } else {
                m = None;
            }
        }
    }
    Ok(recipients
        .into_iter()
        .filter_map(|r| {
            let own = stats.get(&r).copied().unwrap_or_default();
            let team = tree.team_stats(r, &stats);
            (own.total() + team.total() > 0).then_some(Digest {
                recipient_id: r,
                own,
                team,
            })
        })
        .collect())
}

#[derive(Debug, Serialize)]
pub struct Summary {
    pub own: OwnerStats,
    pub team: OwnerStats,
    pub config: StaleWorkConfig,
}

/// `GET /stale-work/summary`: việc của mình + của cấp dưới (người không có cấp dưới ⇒ chỉ của mình).
pub async fn summary_for(conn: &mut PgConnection, user: i32, now: DateTime<Utc>) -> Result<Summary, AppError> {
    let config = get_config(conn).await?;
    let stats = scan(conn, &config, now).await?;
    let tree = load_tree(conn).await?;
    Ok(Summary {
        own: stats.get(&user).copied().unwrap_or_default(),
        team: tree.team_stats(user, &stats),
        config,
    })
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct RunResult {
    pub sent: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<&'static str>,
}

/// Kết quả một lượt kèm thông báo vừa tạo (để tầng route đẩy socket nội bộ sau commit).
#[derive(Debug)]
pub struct Run {
    pub result: RunResult,
    pub notifications: Vec<CreatedNotification>,
}

fn skipped(why: &'static str) -> Run {
    Run {
        result: RunResult {
            sent: 0,
            skipped: Some(why),
        },
        notifications: Vec::new(),
    }
}

/// Một lượt gửi tổng hợp: đúng/quá giờ gửi sáng và hôm nay chưa gửi ⇒ gửi. `force` (chạy tay) bỏ qua giờ và dấu "đã gửi hôm
/// nay" nhưng vẫn ghi dấu. MỘT giao dịch: nhận dấu ⇒ tạo mọi thông báo ⇒ commit (xem tài liệu crate).
pub async fn run_once<F: Features>(
    db_: &TenantDb,
    features: &F,
    now: DateTime<Utc>,
    force: bool,
) -> Result<Run, AppError> {
    let mut tx = db_.begin().await.map_err(AppError::internal)?;
    if !features.enabled(&mut tx, "stale_reminders").await {
        return Ok(skipped("org-flag-off"));
    }
    let (hour, date) = vietnam_clock(now);
    let cfg = get_config(&mut tx).await?;
    if !force {
        if i64::from(hour) < cfg.digest_hour {
            return Ok(skipped("chua-den-gio"));
        }
        // Nhận lượt: chỉ ghi được khi dấu chưa phải hôm nay; bên chạy song song chờ khoá hàng rồi thấy dấu đã có.
        let claimed: Option<String> = sqlx::query_scalar(
            "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE settings.value IS DISTINCT FROM EXCLUDED.value
             RETURNING value",
        )
        .bind(LAST_DIGEST_KEY)
        .bind(&date)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        if claimed.is_none() {
            return Ok(skipped("da-gui-hom-nay"));
        }
    } else {
        put_setting(&mut tx, LAST_DIGEST_KEY, &date, None).await?;
    }
    let digests = build_digests(&mut tx, now).await?;
    let items: Vec<NewNotification> = digests
        .iter()
        .map(|d| {
            let lines: Vec<String> = [
                (d.own.total() > 0).then(|| format!("Của bạn: {}.", describe(&d.own, &cfg))),
                (d.team.total() > 0).then(|| format!("Nhóm của bạn: {}.", describe(&d.team, &cfg))),
            ]
            .into_iter()
            .flatten()
            .collect();
            let kanban =
                d.own.overdue_tasks + d.team.overdue_tasks > 0 && d.own.silent_contacts + d.team.silent_contacts == 0;
            NewNotification {
                recipient_id: d.recipient_id,
                event_type: "stale_work.digest".to_owned(),
                title: "Việc đang treo cần xử lý".to_owned(),
                body: lines.join(" "),
                action_url: Some(if kanban { "/kanban" } else { "/contacts" }.to_owned()),
            }
        })
        .collect();
    let notifications = create_notification(&mut tx, &items).await.map_err(AppError::internal)?;
    tx.commit().await.map_err(AppError::internal)?;
    tracing::info!("Tổng hợp việc treo {date}: gửi {} người", notifications.len());
    Ok(Run {
        result: RunResult {
            sent: notifications.len(),
            skipped: None,
        },
        notifications,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn cau_hinh_chuan_hoa_nhu_ban_ts() {
        assert_eq!(normalize_config(&json!(null)), DEFAULT_CONFIG);
        let c = normalize_config(
            &json!({ "contact_days": 3, "deal_days": 0, "reminder_grace_hours": 0, "digest_hour": 24 }),
        );
        assert_eq!(
            (c.contact_days, c.deal_days, c.reminder_grace_hours, c.digest_hour),
            (3, 14, 0, 8)
        );
        let f = normalize_config(&json!({ "contact_days": 3.5, "digest_hour": "9" }));
        assert_eq!((f.contact_days, f.digest_hour), (7, 8));
        assert_eq!(normalize_config(&json!({ "contact_days": 7.0 })).contact_days, 7);
    }

    #[test]
    fn dong_ho_viet_nam_va_mo_ta() {
        let t: DateTime<Utc> = "2026-11-27T17:30:00Z".parse().unwrap();
        assert_eq!(vietnam_clock(t), (0, "2026-11-28".to_owned()));
        let s = OwnerStats {
            silent_contacts: 5,
            silent_deals: 0,
            overdue_tasks: 2,
            missed_reminders: 1,
        };
        assert_eq!(
            describe(&s, &DEFAULT_CONFIG),
            "5 khách im lặng quá 7 ngày, 2 việc quá hạn, 1 lịch hẹn nhắc bị lỡ"
        );
        assert_eq!(s.total(), 8);
    }

    #[test]
    fn cay_cap_duoi_khong_treo_khi_co_vong() {
        let mut t = Tree {
            manager: HashMap::new(),
            active: HashSet::new(),
            children: HashMap::new(),
        };
        for (id, m) in [(1, Some(2)), (2, Some(1)), (3, Some(1))] {
            t.manager.insert(id, m);
            t.children.entry(m.unwrap()).or_default().push(id);
        }
        let mut d = t.descendants(1);
        d.sort_unstable();
        assert_eq!(d, [2, 3]);
    }
}
