//! Chống lạm dụng kênh theo công ty (SaaS đa công ty dùng chung MỘT app Meta/Zalo), chuyển từ `channel-guard.service.ts`.
//! Bốn lớp:
//!  1. Khoá kênh của chủ nền tảng (`platform.companies.channels_locked`): chặn mọi gửi ra ngoài, nhận tin vẫn chạy.
//!  2. Hạn mức theo gói (`PlanDef::channel_limits`), đếm NGUYÊN TỬ ở bảng `channel_usage` của công ty bằng một câu
//!     `INSERT … ON CONFLICT DO UPDATE … WHERE count + n <= limit`.
//!  3. Theo dõi tỉ lệ lỗi chặn của Graph API (cửa sổ trong RAM mỗi tiến trình, cộng cả kết quả của tiến trình khác qua
//!     `NOTIFY graph`); vượt ngưỡng ⇒ tự tạm dừng gửi hàng loạt/tự động, trạng thái nằm ở DB nên mọi tiến trình cùng thấy.
//!  4. Sự kiện (`channel_events`) để hiện cảnh báo trong app và đọc qua MCP.
//!
//! Bản cài một công ty (`MULTI_TENANT` tắt): mọi hàm là no-op, không phá người tự cài.
//!
//! Khác bản TS: không có ngữ cảnh công ty ngầm (`AsyncLocalStorage`) nên mọi hàm nhận [`CompanyRef`] tường minh; hàm giữ chỗ
//! trong giao dịch nhận `&mut PgConnection` của chính giao dịch ([`ChannelGuard::reserve_in`]).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use serde::Serialize;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use trinity_db::platform::Platform;
use trinity_db::sync::{self, SyncEvent};
use trinity_db::{CompanyRef, Db};
use trinity_kernel::error::AppError;
use trinity_rbac::plan::{ChannelLimits, PlanKey, plan_from_setting};

use crate::error::{BlockCode, ChannelBlocked, GuardError, PendingEvent};
use crate::graph::{GraphOutcome, is_app_level_limit, is_block_outcome};
use crate::window::{
    GraphGuardConfig, GraphVerdict, GraphWindowEvent, HOUR_MS, day_bucket, evaluate_graph_window, hour_bucket,
};

const PLAN_SETTING_KEY: &str = "org_plan";
const VN_OFFSET_MS: i64 = 7 * HOUR_MS;
const PLAN_TTL_MS: u128 = 30_000;
const PAUSE_TTL_MS: u128 = 5_000;

/// Việc đếm hạn mức.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaKind {
    BulkMessage,
    Post,
    CommentReply,
}

impl QuotaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BulkMessage => "bulk_message",
            Self::Post => "post",
            Self::CommentReply => "comment_reply",
        }
    }

    fn limit(self, l: &ChannelLimits) -> u32 {
        match self {
            Self::BulkMessage => l.bulk_messages_per_day,
            Self::Post => l.posts_per_day,
            Self::CommentReply => l.auto_comment_replies_per_hour,
        }
    }

    fn bucket(self, now: i64) -> i64 {
        match self {
            Self::BulkMessage | Self::Post => day_bucket(now),
            Self::CommentReply => hour_bucket(now),
        }
    }

    /// "ngày" hoặc "giờ".
    fn per(self) -> &'static str {
        if self == Self::CommentReply { "giờ" } else { "ngày" }
    }

    fn what(self) -> &'static str {
        match self {
            Self::BulkMessage => "tin gửi hàng loạt",
            Self::Post => "bài đăng/hẹn giờ",
            Self::CommentReply => "lần trả lời bình luận tự động",
        }
    }

    fn unit(self) -> &'static str {
        match self {
            Self::BulkMessage => "tin",
            Self::Post => "bài",
            Self::CommentReply => "lần",
        }
    }
}

/// `Manual`: nhân viên tự gõ/bấm (chỉ chịu khoá kênh). `Auto`: gửi hàng loạt/tự động (chịu cả tạm dừng tự động).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboundMode {
    Manual,
    Auto,
}

/// `Meta` = Facebook (chịu tạm dừng do Graph); `Other` = Zalo (chỉ chịu khoá kênh).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboundScope {
    Meta,
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BlockReason {
    pub code: BlockCode,
    pub message: String,
    /// Tạm dừng: tới lúc này mới gửi lại được.
    pub until: Option<DateTime<Utc>>,
}

/// Cảnh báo nhẹ cho MỌI người dùng đã đăng nhập (banner). Không lộ hạn mức hay sự kiện.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChannelAlerts {
    pub enforced: bool,
    pub locked: bool,
    pub paused: bool,
    pub warnings: Vec<String>,
}

/// Kết quả [`ChannelGuard::prepare_reserve`]: hạn mức và khung đã đọc sẵn, dùng trong giao dịch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReserveContext {
    pub kind: QuotaKind,
    pub limit: u32,
    pub bucket: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AutoPause {
    pub until: String,
    pub reason: String,
    pub since: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Usage {
    pub bulk_messages_today: i64,
    pub posts_today: i64,
    pub auto_comment_replies_this_hour: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LockStatus {
    pub locked: bool,
    pub reason: Option<String>,
    pub since: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EventOut {
    pub id: i32,
    pub kind: String,
    pub message: String,
    pub at: String,
}

/// `ChannelLimits` của TS (khoá camelCase).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LimitsOut {
    #[serde(rename = "bulkMessagesPerDay")]
    pub bulk_messages_per_day: u32,
    #[serde(rename = "recipientsPerCampaign")]
    pub recipients_per_campaign: u32,
    #[serde(rename = "postsPerDay")]
    pub posts_per_day: u32,
    #[serde(rename = "autoCommentRepliesPerHour")]
    pub auto_comment_replies_per_hour: u32,
}

impl From<ChannelLimits> for LimitsOut {
    fn from(l: ChannelLimits) -> Self {
        Self {
            bulk_messages_per_day: l.bulk_messages_per_day,
            recipients_per_campaign: l.recipients_per_campaign,
            posts_per_day: l.posts_per_day,
            auto_comment_replies_per_hour: l.auto_comment_replies_per_hour,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChannelGuardStatus {
    /// `false` = bản cài một công ty: không có hạn mức/khoá/tạm dừng.
    pub enforced: bool,
    pub plan: &'static str,
    pub limits: LimitsOut,
    pub usage: Usage,
    pub locked: LockStatus,
    pub auto_pause: Option<AutoPause>,
    pub warnings: Vec<String>,
    pub recent_events: Vec<EventOut>,
}

type EventRow = (i32, String, String, Option<Value>, DateTime<Utc>);

#[derive(Default)]
struct State {
    /// Cửa sổ lời gọi Graph theo công ty.
    windows: HashMap<i32, Vec<GraphWindowEvent>>,
    pause_cache: HashMap<i32, (Option<AutoPause>, Instant)>,
    plan_cache: HashMap<i32, (PlanKey, Instant)>,
    logged: HashSet<String>,
    /// Trước mốc này (ms), gửi tự động của MỌI công ty lùi lại.
    app_backoff_until: i64,
    app_hits: Vec<i64>,
}

struct Inner {
    db: Db,
    platform: Platform,
    cfg: GraphGuardConfig,
    state: Mutex<State>,
}

/// Bộ chống lạm dụng kênh. Rẻ để sao chép (một `Arc`); dựng một lần ở `serve` rồi chia sẻ.
#[derive(Clone)]
pub struct ChannelGuard {
    inner: Arc<Inner>,
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn at(ms: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms).single().unwrap_or_default()
}

/// `Date.prototype.toISOString`.
fn iso(d: DateTime<Utc>) -> String {
    d.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `HH:mm dd/MM` theo giờ Việt Nam.
fn format_vn(iso_str: &str) -> String {
    let ms = DateTime::parse_from_rfc3339(iso_str).map_or(0, |d| d.timestamp_millis());
    at(ms + VN_OFFSET_MS).format("%H:%M %d/%m").to_string()
}

fn internal(e: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> AppError {
    AppError::internal(e)
}

impl ChannelGuard {
    pub fn new(db: Db, platform: Platform) -> Self {
        Self::with_config(db, platform, GraphGuardConfig::from_env())
    }

    pub fn with_config(db: Db, platform: Platform, cfg: GraphGuardConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                db,
                platform,
                cfg,
                state: Mutex::new(State::default()),
            }),
        }
    }

    fn st(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Có áp hạn mức/khoá không (chỉ khi chạy nhiều công ty).
    pub fn enforced(&self) -> bool {
        self.inner.platform.multi_tenant()
    }

    async fn conn(&self, company: CompanyRef) -> Result<trinity_db::TenantConn, AppError> {
        let t = self.inner.db.tenant(company).await.map_err(internal)?;
        t.acquire().await.map_err(internal)
    }

    // ───────────────────────── hạn mức & chặn

    /// Gói của công ty (cache 30 giây). Vắng/rác: công ty ≥ 2 = gói đăng ký mặc định, còn lại `custom`.
    pub async fn plan(&self, company: CompanyRef) -> PlanKey {
        let id = company.id();
        if let Some((v, t)) = self.st().plan_cache.get(&id)
            && t.elapsed().as_millis() < PLAN_TTL_MS
        {
            return *v;
        }
        let raw = async {
            let mut c = self.conn(company).await?;
            sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = $1")
                .bind(PLAN_SETTING_KEY)
                .fetch_optional(&mut *c)
                .await
                .map_err(internal)
        }
        .await;
        let v = match raw {
            Ok(r) => plan_from_setting(r.as_deref(), Some(id)),
            Err(e) => {
                tracing::warn!("Không đọc được gói để tính hạn mức kênh: {e}");
                plan_from_setting(None, Some(id))
            }
        };
        self.st().plan_cache.insert(id, (v, Instant::now()));
        v
    }

    pub async fn limits(&self, company: CompanyRef) -> ChannelLimits {
        self.plan(company).await.def().channel_limits
    }

    /// Lý do đang chặn gửi (`None` = được gửi). `Auto` xét thêm tạm dừng tự động.
    pub async fn block_reason(
        &self,
        company: CompanyRef,
        mode: OutboundMode,
        scope: OutboundScope,
    ) -> Result<Option<BlockReason>, AppError> {
        if !self.enforced() {
            return Ok(None);
        }
        let lock = self.inner.platform.channel_lock(company.id()).await.map_err(internal)?;
        if lock.locked {
            let why = lock
                .reason
                .as_deref()
                .filter(|r| !r.is_empty())
                .map_or_else(String::new, |r| format!(" ({r})"));
            return Ok(Some(BlockReason {
                code: BlockCode::ChannelLocked,
                message: format!(
                    "Kênh gửi tin/đăng bài của công ty đang bị tạm khoá{why}. Nhận tin vẫn chạy bình thường; liên hệ Trinity để mở lại."
                ),
                until: None,
            }));
        }
        // Tạm dừng do lỗi Graph / backoff của Meta chỉ áp cho Facebook; Zalo không bị chặn theo.
        if mode == OutboundMode::Auto && scope == OutboundScope::Meta {
            let backoff = self.st().app_backoff_until;
            if now_ms() < backoff {
                let until = at(backoff);
                return Ok(Some(BlockReason {
                    code: BlockCode::ChannelPaused,
                    message: format!(
                        "Facebook đang giới hạn tần suất chung nên gửi hàng loạt và tự động tạm lùi đến {}. Thử lại sau vài phút; tin nhân viên tự trả lời vẫn gửi được.",
                        format_vn(&iso(until))
                    ),
                    until: Some(until),
                }));
            }
            if let Some(p) = self.auto_pause(company).await {
                let until = DateTime::parse_from_rfc3339(&p.until).map_or_else(|_| at(0), |d| d.with_timezone(&Utc));
                return Ok(Some(BlockReason {
                    code: BlockCode::ChannelPaused,
                    message: format!(
                        "Gửi hàng loạt và tự động đang tạm dừng đến {} vì Facebook báo lỗi chặn/spam ({}). Tin nhân viên tự trả lời vẫn gửi được.",
                        format_vn(&p.until),
                        p.reason
                    ),
                    until: Some(until),
                }));
            }
        }
        Ok(None)
    }

    /// Lỗi [`ChannelBlocked`] nếu đang bị khoá (hoặc tạm dừng, với `Auto`).
    pub async fn assert_outbound(
        &self,
        company: CompanyRef,
        mode: OutboundMode,
        scope: OutboundScope,
    ) -> Result<(), GuardError> {
        match self.block_reason(company, mode, scope).await? {
            Some(r) => Err(ChannelBlocked::new(r.code, r.message).into()),
            None => Ok(()),
        }
    }

    /// Chuẩn bị giữ chỗ: kiểm khoá/tạm dừng + đọc hạn mức của gói. Gọi TRƯỚC khi mở giao dịch rồi truyền kết quả vào
    /// [`Self::reserve_in`], để bên trong giao dịch chỉ còn đúng một câu SQL trên chính kết nối của giao dịch.
    /// `None` khi không áp hạn mức (bản cài một công ty).
    pub async fn prepare_reserve(
        &self,
        company: CompanyRef,
        kind: QuotaKind,
        scope: OutboundScope,
    ) -> Result<Option<ReserveContext>, GuardError> {
        if !self.enforced() {
            return Ok(None);
        }
        let mode = if kind == QuotaKind::Post {
            OutboundMode::Manual
        } else {
            OutboundMode::Auto
        };
        self.assert_outbound(company, mode, scope).await?;
        Ok(Some(ReserveContext {
            kind,
            limit: kind.limit(&self.limits(company).await),
            bucket: at(kind.bucket(now_ms())),
        }))
    }

    /// Giữ chỗ `amount` đơn vị NGUYÊN TỬ trên `conn` (kết nối của giao dịch, đã gắn công ty) rồi mới gửi; trả khung đã ghi để
    /// [`Self::refund`] hoàn đúng khung. Vượt ⇒ `channel_quota` (429); sự kiện `limit_exceeded` KHÔNG ghi ngay mà nằm trong lỗi,
    /// người gọi ghi bằng [`Self::record_blocked`] SAU giao dịch.
    pub async fn reserve_in(
        &self,
        conn: &mut PgConnection,
        ctx: &ReserveContext,
        amount: u32,
    ) -> Result<DateTime<Utc>, GuardError> {
        let q = ctx.kind;
        let limit = ctx.limit;
        if amount > limit {
            // Một lần xin vượt cả hạn mức của khoảng: không phải "đã dùng hết", nên nói rõ trần một lần và không ghi limit_exceeded.
            return Err(ChannelBlocked::new(
                BlockCode::ChannelQuota,
                format!(
                    "Một lần chỉ được {} tối đa {limit} ({}) theo gói hiện tại, bạn đang xin {amount}. Chia nhỏ hoặc nâng gói.",
                    q.what(),
                    if q.per() == "giờ" { "mỗi giờ" } else { "mỗi ngày" }
                ),
            )
            .into());
        }
        let row: Option<(i32,)> = sqlx::query_as(
            "INSERT INTO channel_usage (kind, bucket, count) VALUES ($1, $2, $3)
             ON CONFLICT (kind, bucket) DO UPDATE SET count = channel_usage.count + EXCLUDED.count
               WHERE channel_usage.count + EXCLUDED.count <= $4
             RETURNING count",
        )
        .bind(q.as_str())
        .bind(ctx.bucket)
        .bind(i32::try_from(amount).unwrap_or(i32::MAX))
        .bind(i32::try_from(limit).unwrap_or(i32::MAX))
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| GuardError::App(internal(e)))?;
        if row.is_some() {
            return Ok(ctx.bucket);
        }
        let message = format!(
            "Đã hết hạn mức {} của gói ({limit} {}/{}). Thử lại {} hoặc nâng gói.",
            q.what(),
            q.unit(),
            q.per(),
            if q.per() == "giờ" {
                "ở giờ sau"
            } else {
                "vào ngày mai"
            }
        );
        let mut err = ChannelBlocked::new(BlockCode::ChannelQuota, message.clone());
        err.pending_event = Some(PendingEvent {
            kind: "limit_exceeded",
            message,
            meta: json!({ "quota": q.as_str(), "limit": limit, "wanted": amount }),
            dedupe: format!("{}:{}", q.as_str(), ctx.bucket.timestamp_millis()),
            log: format!("vượt hạn mức {} ({limit}/{}), cần thêm {amount}", q.as_str(), q.per()),
        });
        Err(err.into())
    }

    /// Giữ chỗ trên kết nối riêng (không nằm trong giao dịch của người gọi): tự chuẩn bị, tự ghi sự kiện khi vượt.
    /// `Ok(None)` khi không áp hạn mức (bản một công ty hoặc `amount` = 0).
    pub async fn reserve(
        &self,
        company: CompanyRef,
        kind: QuotaKind,
        amount: u32,
        scope: OutboundScope,
    ) -> Result<Option<DateTime<Utc>>, GuardError> {
        if !self.enforced() || amount == 0 {
            return Ok(None);
        }
        let Some(ctx) = self.prepare_reserve(company, kind, scope).await? else {
            return Ok(None);
        };
        let mut conn = self.conn(company).await?;
        match self.reserve_in(&mut conn, &ctx, amount).await {
            Ok(b) => Ok(Some(b)),
            Err(mut e) => {
                self.record_blocked(company, &mut e).await;
                Err(e)
            }
        }
    }

    /// Ghi log + sự kiện của một lần bị chặn (xem [`Self::reserve_in`]). Gọi SAU giao dịch; lỗi khác loại thì bỏ qua.
    pub async fn record_blocked(&self, company: CompanyRef, err: &mut GuardError) {
        let GuardError::Blocked(b) = err else { return };
        let Some(e) = b.pending_event.take() else { return };
        tracing::warn!("Công ty {}: {}", company.id(), e.log);
        self.event(company, e.kind, &e.message, &e.meta, Some(&e.dedupe)).await;
    }

    /// Hoàn `amount` đơn vị đã giữ chỗ vào ĐÚNG khung (`bucket` do giữ chỗ trả) — gửi thất bại ⇒ không tính vào hạn mức.
    /// Không xuống dưới 0.
    pub async fn refund(&self, company: CompanyRef, kind: QuotaKind, amount: u32, bucket: Option<DateTime<Utc>>) {
        if !self.enforced() || amount == 0 {
            return;
        }
        let bucket = bucket.unwrap_or_else(|| at(kind.bucket(now_ms())));
        let r = async {
            let mut c = self.conn(company).await?;
            sqlx::query("UPDATE channel_usage SET count = GREATEST(count - $3, 0) WHERE kind = $1 AND bucket = $2")
                .bind(kind.as_str())
                .bind(bucket)
                .bind(i32::try_from(amount).unwrap_or(i32::MAX))
                .execute(&mut *c)
                .await
                .map_err(internal)
        }
        .await;
        if let Err(e) = r {
            tracing::warn!("Không hoàn được hạn mức {}: {e}", kind.as_str());
        }
    }

    /// Số người nhận tối đa của một chiến dịch.
    pub async fn assert_recipients(&self, company: CompanyRef, count: u32) -> Result<(), GuardError> {
        if !self.enforced() {
            return Ok(());
        }
        // Lúc lên lịch chỉ kiểm khoá; tạm dừng được kiểm theo giờ gửi.
        self.assert_outbound(company, OutboundMode::Manual, OutboundScope::Meta)
            .await?;
        let max = self.limits(company).await.recipients_per_campaign;
        if count > max {
            let message = format!(
                "Chiến dịch có {count} người nhận, gói hiện tại cho tối đa {max} người mỗi chiến dịch. Lọc bớt đối tượng hoặc chia nhỏ chiến dịch."
            );
            tracing::warn!(
                "Công ty {}: chiến dịch {count} người nhận vượt trần {max}",
                company.id()
            );
            self.event(
                company,
                "limit_exceeded",
                &message,
                &json!({ "quota": "recipients", "limit": max, "wanted": count }),
                Some(&format!("recipients:{}", day_bucket(now_ms()))),
            )
            .await;
            return Err(ChannelBlocked::new(BlockCode::ChannelQuota, message).into());
        }
        Ok(())
    }

    /// Trần người nhận để cắt danh sách (phòng thủ khi chốt người nhận).
    pub async fn recipient_cap(&self, company: CompanyRef) -> u32 {
        if self.enforced() {
            self.limits(company).await.recipients_per_campaign
        } else {
            u32::MAX
        }
    }

    // ───────────────────────── tỉ lệ lỗi Graph → tự tạm dừng

    /// Gọi sau mỗi lời gọi Graph của tiến trình này (công ty của lời gọi): cộng vào cửa sổ, tạm dừng nếu vượt ngưỡng, và
    /// phát `NOTIFY graph` cho tiến trình khác (chỉ lời gọi GỬI; đọc không đáng một `NOTIFY`).
    pub async fn record_graph(&self, company: CompanyRef, o: GraphOutcome) {
        if !self.enforced() {
            return;
        }
        let verdict = self.apply_graph(Some(company), &o);
        if o.send {
            self.publish_graph(company, &o).await;
        }
        if let Some(v) = verdict {
            self.pause(company, &v).await;
        }
    }

    async fn publish_graph(&self, company: CompanyRef, o: &GraphOutcome) {
        let mut f = Map::new();
        f.insert("ok".into(), json!(o.ok));
        f.insert("h".into(), json!(o.http_status));
        f.insert("code".into(), json!(o.code));
        f.insert("sub".into(), json!(o.subcode));
        f.insert("send".into(), json!(true));
        let r = async {
            let mut c = self.inner.db.raw_pool().acquire().await.map_err(|e| e.to_string())?;
            sync::publish_in_tx(&mut c, "graph", i64::from(company.id()), &f)
                .await
                .map_err(|e| e.to_string())
        }
        .await;
        if let Err(e) = r {
            tracing::warn!("Không phát được tin graph: {e}");
        }
    }

    /// Xử lý một sự kiện từ `trinity_sync` (`Message` loại `graph` của tiến trình khác cộng vào cửa sổ lỗi và backoff của
    /// tiến trình này; `Resync` xoá cache cục bộ, trạng thái tạm dừng và gói nạp lại từ DB).
    pub async fn on_sync_event(&self, ev: &SyncEvent) {
        match ev {
            SyncEvent::Resync => {
                let mut s = self.st();
                s.pause_cache.clear();
                s.plan_cache.clear();
            }
            SyncEvent::Message(env) if env.kind == "graph" => {
                let f = &env.fields;
                let o = GraphOutcome {
                    ok: f.get("ok").and_then(Value::as_bool) == Some(true),
                    http_status: f.get("h").and_then(Value::as_i64).unwrap_or(0),
                    code: f.get("code").and_then(Value::as_i64),
                    subcode: f.get("sub").and_then(Value::as_i64),
                    send: f.get("send").and_then(Value::as_bool) != Some(false),
                };
                let company = (env.company > 0).then(|| CompanyRef::new(env.company).ok()).flatten();
                if let Some(v) = self.apply_graph(company, &o)
                    && let Some(c) = company
                {
                    self.pause(c, &v).await;
                }
            }
            SyncEvent::Message(_) => {}
        }
    }

    /// Cộng một kết quả vào cửa sổ lỗi / backoff của tiến trình này. Trả phán quyết khi công ty vừa vượt ngưỡng.
    pub fn apply_graph(&self, company: Option<CompanyRef>, o: &GraphOutcome) -> Option<GraphVerdict> {
        if !self.enforced() {
            return None;
        }
        // Lời gọi ĐỌC không tính vào bất kỳ ngưỡng nào, kể cả backoff cấp app.
        if !o.send {
            return None;
        }
        let now = now_ms();
        let cfg = &self.inner.cfg;
        let mut s = self.st();
        if !o.ok && is_app_level_limit(o) {
            // Giới hạn cấp app dùng chung: không đổ lỗi cho công ty đang gọi. Cần LẶP (vài lần trong 1 phút) mới lùi gửi tự động.
            s.app_hits.retain(|t| now - t <= cfg.app_hit_window_ms);
            s.app_hits.push(now);
            if s.app_hits.len() >= cfg.app_backoff_hits {
                if s.app_backoff_until < now {
                    tracing::warn!(
                        "Facebook giới hạn tần suất cấp app (#{}, {} lần/phút) — lùi gửi tự động {} phút",
                        o.code.unwrap_or(o.http_status),
                        s.app_hits.len(),
                        cfg.app_backoff_ms / 60_000
                    );
                }
                s.app_backoff_until = now + cfg.app_backoff_ms;
                s.app_hits.clear();
            }
            return None;
        }
        let company = company?;
        let block = !o.ok && is_block_outcome(o);
        let win = s.windows.entry(company.id()).or_default();
        win.retain(|e| now - e.t <= cfg.window_ms);
        win.push(GraphWindowEvent {
            t: now,
            block,
            code: o.code,
        });
        if !block {
            return None;
        }
        let verdict = evaluate_graph_window(win, now, cfg);
        if !verdict.trip {
            return None;
        }
        s.windows.remove(&company.id());
        Some(verdict)
    }

    /// Ghi trạng thái tạm dừng (lỗi ghi chỉ log: không làm hỏng lời gọi thật).
    async fn pause(&self, company: CompanyRef, v: &GraphVerdict) {
        let id = company.id();
        // Hai tiến trình cùng thấy đủ lỗi (mỗi bên cộng kết quả của bên kia): đọc DB tươi để bên đến sau không ghi trùng sự kiện.
        self.st().pause_cache.remove(&id);
        if self.auto_pause(company).await.is_some() {
            return;
        }
        let until = iso(at(now_ms() + self.inner.cfg.pause_ms));
        tracing::error!(
            "Công ty {id}: TỰ TẠM DỪNG gửi hàng loạt/tự động đến {until} — {} {}",
            v.reason,
            json!(v.codes)
        );
        let meta =
            json!({ "until": until, "reason": v.reason, "calls": v.calls, "blocks": v.blocks, "codes": v.codes });
        let message: String = format!("Tự tạm dừng gửi hàng loạt và tự động: {}.", v.reason)
            .chars()
            .take(1000)
            .collect();
        // Ghi NGUYÊN TỬ: khoá tư vấn theo công ty rồi chỉ chèn khi chưa có `auto_pause` còn hiệu lực — hai tiến trình cùng
        // thấy đủ lỗi thì chỉ một sự kiện được ghi.
        let r: Result<(), AppError> = async {
            let t = self.inner.db.tenant(company).await.map_err(internal)?;
            let mut tx = t.begin().await.map_err(internal)?;
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
                .bind(format!("channel_auto_pause:{id}"))
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
            sqlx::query(
                "INSERT INTO channel_events (kind, message, meta)
                 SELECT 'auto_pause', $1, $2::jsonb
                 WHERE NOT EXISTS (
                   SELECT 1 FROM (SELECT kind, meta FROM channel_events WHERE kind IN ('auto_pause', 'auto_resume') ORDER BY id DESC LIMIT 1) lp
                   WHERE lp.kind = 'auto_pause' AND (lp.meta->>'until')::timestamptz > now()
                 )",
            )
            .bind(&message)
            .bind(meta.to_string())
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
            tx.commit().await.map_err(internal)
        }
        .await;
        if let Err(e) = r {
            tracing::warn!("Không ghi được sự kiện kênh auto_pause: {e}");
        }
        self.st().pause_cache.remove(&id);
    }

    /// Trạng thái tạm dừng tự động đang hiệu lực (cache 5 giây). Không đọc được ⇒ không chặn nhầm cả công ty (fail-open);
    /// khoá của chủ nền tảng vẫn có hiệu lực.
    pub async fn auto_pause(&self, company: CompanyRef) -> Option<AutoPause> {
        if !self.enforced() {
            return None;
        }
        let id = company.id();
        if let Some((v, t)) = self.st().pause_cache.get(&id)
            && t.elapsed().as_millis() < PAUSE_TTL_MS
        {
            return v.clone();
        }
        let rows = async {
            let mut c = self.conn(company).await?;
            sqlx::query_as::<_, EventRow>(
                "SELECT id, kind, message, meta, created_at FROM channel_events
                 WHERE kind IN ('auto_pause', 'auto_resume') ORDER BY id DESC LIMIT 1",
            )
            .fetch_all(&mut *c)
            .await
            .map_err(internal)
        }
        .await;
        let v = match rows {
            Ok(rows) => rows.into_iter().next().and_then(|(_, kind, _, meta, created)| {
                let meta = meta.unwrap_or(Value::Null);
                let until = meta.get("until").and_then(Value::as_str)?;
                let ok = kind == "auto_pause"
                    && DateTime::parse_from_rfc3339(until).is_ok_and(|d| d.timestamp_millis() > now_ms());
                ok.then(|| AutoPause {
                    until: until.to_owned(),
                    reason: meta.get("reason").and_then(Value::as_str).unwrap_or("").to_owned(),
                    since: iso(created),
                })
            }),
            Err(e) => {
                tracing::warn!("Không đọc được trạng thái tạm dừng kênh: {e}");
                None
            }
        };
        self.st().pause_cache.insert(id, (v.clone(), Instant::now()));
        v
    }

    /// Mở lại gửi tự động sớm (chủ nền tảng/CLI sau khi đã xử lý nguyên nhân). `false` nếu đang không tạm dừng.
    pub async fn resume(&self, company: CompanyRef, note: &str) -> bool {
        if !self.enforced() || self.auto_pause(company).await.is_none() {
            return false;
        }
        self.event(company, "auto_resume", note, &json!({}), None).await;
        self.st().pause_cache.remove(&company.id());
        true
    }

    // ───────────────────────── sự kiện & trạng thái

    /// Ghi sự kiện (lỗi ghi không được làm hỏng việc chính). `dedupe` = khoá để mỗi khung chỉ ghi một lần.
    async fn event(&self, company: CompanyRef, kind: &str, message: &str, meta: &Value, dedupe: Option<&str>) {
        if let Some(d) = dedupe {
            let key = format!("{}:{kind}:{d}", company.id());
            let mut s = self.st();
            if s.logged.contains(&key) {
                return;
            }
            if s.logged.len() > 5000 {
                s.logged.clear();
            }
            s.logged.insert(key);
        }
        let r = async {
            let mut c = self.conn(company).await?;
            sqlx::query("INSERT INTO channel_events (kind, message, meta) VALUES ($1, $2, $3::jsonb)")
                .bind(kind)
                .bind(message.chars().take(1000).collect::<String>())
                .bind(meta.to_string())
                .execute(&mut *c)
                .await
                .map_err(internal)
        }
        .await;
        if let Err(e) = r {
            tracing::warn!("Không ghi được sự kiện kênh {kind}: {e}");
        }
    }

    pub async fn alerts(&self, company: CompanyRef) -> Result<ChannelAlerts, AppError> {
        if !self.enforced() {
            return Ok(ChannelAlerts {
                enforced: false,
                locked: false,
                paused: false,
                warnings: Vec::new(),
            });
        }
        let s = self.status(company).await?;
        Ok(ChannelAlerts {
            enforced: true,
            locked: s.locked.locked,
            paused: s.auto_pause.is_some(),
            warnings: s.warnings,
        })
    }

    pub async fn status(&self, company: CompanyRef) -> Result<ChannelGuardStatus, AppError> {
        let plan = self.plan(company).await;
        let limits = plan.def().channel_limits;
        if !self.enforced() {
            return Ok(ChannelGuardStatus {
                enforced: false,
                plan: plan.as_str(),
                limits: limits.into(),
                usage: Usage {
                    bulk_messages_today: 0,
                    posts_today: 0,
                    auto_comment_replies_this_hour: 0,
                },
                locked: LockStatus {
                    locked: false,
                    reason: None,
                    since: None,
                },
                auto_pause: None,
                warnings: Vec::new(),
                recent_events: Vec::new(),
            });
        }
        let now = now_ms();
        let mut c = self.conn(company).await?;
        let mut used = Vec::with_capacity(3);
        for kind in [QuotaKind::BulkMessage, QuotaKind::Post, QuotaKind::CommentReply] {
            let n: Option<i32> = sqlx::query_scalar("SELECT count FROM channel_usage WHERE kind = $1 AND bucket = $2")
                .bind(kind.as_str())
                .bind(at(kind.bucket(now)))
                .fetch_optional(&mut *c)
                .await
                .map_err(internal)?;
            used.push(i64::from(n.unwrap_or(0)));
        }
        let events: Vec<EventRow> =
            sqlx::query_as("SELECT id, kind, message, meta, created_at FROM channel_events ORDER BY id DESC LIMIT 10")
                .fetch_all(&mut *c)
                .await
                .map_err(internal)?;
        drop(c);
        let lock = self.inner.platform.channel_lock(company.id()).await.map_err(internal)?;
        let pause = self.auto_pause(company).await;
        let mut warnings = Vec::new();
        if lock.locked {
            let why = lock
                .reason
                .as_deref()
                .filter(|r| !r.is_empty())
                .map_or_else(String::new, |r| format!(": {r}"));
            warnings.push(format!("Kênh gửi ra ngoài đang bị tạm khoá{why}. Nhận tin vẫn chạy."));
        }
        if let Some(p) = &pause {
            warnings.push(format!(
                "Gửi hàng loạt và tự động tạm dừng đến {}: {}.",
                format_vn(&p.until),
                p.reason
            ));
        }
        let mut near = |n: i64, max: u32, what: &str| {
            let max_f = f64::from(max);
            if n >= i64::from(max) {
                warnings.push(format!("Đã dùng hết hạn mức {what} ({n}/{max})."));
            } else if n as f64 >= max_f * 0.8 {
                warnings.push(format!("Sắp hết hạn mức {what} ({n}/{max})."));
            }
        };
        near(used[0], limits.bulk_messages_per_day, "tin gửi hàng loạt hôm nay");
        near(used[1], limits.posts_per_day, "bài đăng hôm nay");
        near(
            used[2],
            limits.auto_comment_replies_per_hour,
            "trả lời bình luận tự động giờ này",
        );
        Ok(ChannelGuardStatus {
            enforced: true,
            plan: plan.as_str(),
            limits: limits.into(),
            usage: Usage {
                bulk_messages_today: used[0],
                posts_today: used[1],
                auto_comment_replies_this_hour: used[2],
            },
            locked: LockStatus {
                locked: lock.locked,
                reason: lock.reason,
                since: lock.locked_at.map(iso),
            },
            auto_pause: pause,
            warnings,
            recent_events: events
                .into_iter()
                .map(|(id, kind, message, _, created)| EventOut {
                    id,
                    kind,
                    message,
                    at: iso(created),
                })
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dinh_dang_gio_viet_nam() {
        // 03:30 UTC ngày 26/11 = 10:30 26/11 VN.
        assert_eq!(format_vn("2026-11-26T03:30:00.000Z"), "10:30 26/11");
        assert_eq!(format_vn("2026-11-26T20:05:00.000Z"), "03:05 27/11");
    }

    #[test]
    fn iso_giong_to_iso_string() {
        assert_eq!(iso(at(1_795_663_800_123)), "2026-11-26T03:30:00.123Z");
    }
}
