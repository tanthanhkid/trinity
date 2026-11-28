//! Bản cài thật của các port tool Fanpage (M44b) bằng dịch vụ của `mod-facebook` (bình luận M49, link chat M50, gửi hàng loạt M51,
//! danh sách Page) và `mod-social` (bài hẹn giờ M54a). Hàm [`fanpage_deps`] dựng sẵn [`FanpagePorts`] để `serve` đưa vào
//! [`super::register_fanpage`].
//!
//! `FlowsPort` cài bằng dịch vụ kịch bản của `FacebookIngest` (M50b).
//!
//! Quy ước: mỗi lời gọi tự xin kết nối của mình và nhả NGAY trước khi gọi dịch vụ khác (không giữ hai kết nối, không giữ kết nối
//! khi gọi Graph). Lỗi nghiệp vụ 400/404 của dịch vụ ⇒ `ToolError::User` kèm câu nguyên văn; mã khác đi qua [`app_err`].

use std::sync::Arc;

use chrono::{DateTime, Utc};
use mod_channel_guard::ChannelGuard;
use mod_facebook::admin_guide::{self, GuideInput, PageKey};
use mod_facebook::broadcast::{Audience, BroadcastInput, send_time};
use mod_facebook::chat_links::{self, ChatLinkInput, LinkUrls};
use mod_facebook::comments::{self, DryRunInput, ListQuery};
use mod_facebook::config::Env;
use mod_facebook::flows::FlowInput;
use mod_facebook::ingest::{FacebookIngest, GraphFactory};
use mod_facebook::pages;
use mod_social::media::MediaStore;
use mod_social::posts::{self, PostCtx};
use serde_json::{Map, Value};
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_kernel::error::{AppError, Message};
use trinity_kernel::instant::parse_instant_with;
use trinity_kernel::vn_time::js_iso_string;

use super::fanpage::{
    AdminGuidePort, BroadcastsPort, ChatLinksPort, CommentQuery, CommentsPort, FanpagePorts, FlowsPort, PageRef,
    PagesPort, ScheduledPostsPort,
};
use crate::deps::{app_err, to_json};
use crate::exec::ToolError;
use crate::protocol::BoxFuture;

type PortFut<'a, T> = BoxFuture<'a, Result<T, ToolError>>;

/// Hàm đánh thức job gửi hàng loạt (bỏ qua chu kỳ một phút); `serve` nối với bộ lập lịch.
pub type Kick = Arc<dyn Fn() + Send + Sync>;

/// Tên gọi khác của [`FanpagePorts`]: thứ `register_fanpage` nhận.
pub type FanpageDeps = FanpagePorts;

/// Phần cần thêm để huỷ bài hẹn giờ (`mod_social::posts::cancel` dựng `PostCtx` đủ kho tệp, Graph và bộ chặn kênh).
pub struct PostsDeps {
    pub store: Arc<MediaStore>,
    pub graph_for: GraphFactory,
    pub guard: ChannelGuard,
}

/// Dựng sẵn mọi port đã có dịch vụ thật. `ingest` là bản dùng chung của `serve` (cùng DB, env, Graph, `ChannelGuard`);
/// `multi_tenant` quyết định link chat có kèm gợi ý công ty; `kick` đánh thức job gửi hàng loạt; `posts` vắng ⇒ tool huỷ bài
/// hẹn giờ báo chưa có tính năng. `flows` cài bằng dịch vụ kịch bản của `FacebookIngest` (M50b).
pub fn fanpage_deps(
    ingest: Arc<FacebookIngest>,
    multi_tenant: bool,
    kick: Option<Kick>,
    posts: Option<PostsDeps>,
) -> FanpageDeps {
    FanpagePorts {
        pages: Some(Arc::new(PagesAdapter { ingest: ingest.clone() })),
        comments: Some(Arc::new(CommentsAdapter { ingest: ingest.clone() })),
        chat_links: Some(Arc::new(ChatLinksAdapter {
            ingest: ingest.clone(),
            multi_tenant,
        })),
        flows: Some(Arc::new(FlowsAdapter { ingest: ingest.clone() })),
        admin_guide: Some(Arc::new(AdminGuideAdapter { ingest: ingest.clone() })),
        broadcasts: Some(Arc::new(BroadcastsAdapter {
            ingest: ingest.clone(),
            kick,
        })),
        posts: posts.map(|p| {
            Arc::new(PostsAdapter {
                db: ingest.db.clone(),
                env: ingest.env.clone(),
                deps: p,
            }) as Arc<dyn ScheduledPostsPort>
        }),
    }
}

// ------------------------------------------------------------------ hàm dùng chung

fn message_text(m: Message) -> String {
    match m {
        Message::One(s) => s,
        Message::Many(v) => v.join("; "),
    }
}

/// 400/404 nghiệp vụ ⇒ câu nguyên văn cho AI (như `BadRequestException`/`NotFoundException` của bản Node); mã khác ⇒ [`app_err`].
fn port_err(e: AppError) -> ToolError {
    match e {
        AppError::Http(h) if matches!(h.status(), 400 | 404) => ToolError::User(message_text(h.body().message)),
        other => app_err(other),
    }
}

async fn conn(db: &Db, company: CompanyRef) -> Result<TenantConn, ToolError> {
    let t = db
        .tenant(company)
        .await
        .map_err(|e| ToolError::Internal(e.to_string()))?;
    t.acquire().await.map_err(|e| ToolError::Internal(e.to_string()))
}

/// `{ data: [...] }` của dịch vụ ⇒ mảng hàng.
fn data_rows(v: Value) -> Vec<Value> {
    if let Value::Object(mut o) = v
        && let Some(Value::Array(a)) = o.remove("data")
    {
        a
    } else {
        Vec::new()
    }
}

fn take_rows(mut rows: Vec<Value>, limit: i64) -> Vec<Value> {
    rows.truncate(usize::try_from(limit.max(0)).unwrap_or(0));
    rows
}

/// Hàng bình luận có `created_at` (RFC 3339) từ `since` trở đi.
fn created_since(row: &Value, since: DateTime<Utc>) -> bool {
    row.get("created_at")
        .and_then(Value::as_str)
        .and_then(|t| parse_instant_with(t, 0))
        .is_some_and(|t| t >= since)
}

/// Hẹn quá 7 ngày ⇒ lỗi người dùng (cùng câu và cùng trần với `send_time` của dịch vụ); bỏ trống hoặc đã qua = gửi ngay.
fn check_send_at(at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> Result<(), ToolError> {
    let iso = at.map(js_iso_string);
    send_time(iso.as_deref(), now)
        .map(|_| ())
        .map_err(|e| port_err(AppError::from(e)))
}

fn normalize_post(raw: &str, page_id: Option<&str>) -> Result<Option<String>, ToolError> {
    comments::normalize_post_id(Some(raw), page_id).map_err(|e| port_err(AppError::from(e)))
}

fn status_of(row: &Value) -> &str {
    row.get("status").and_then(Value::as_str).unwrap_or("")
}

// ------------------------------------------------------------------ Page

struct PagesAdapter {
    ingest: Arc<FacebookIngest>,
}

impl PagesPort for PagesAdapter {
    fn pages(&self, company: CompanyRef) -> PortFut<'_, Vec<PageRef>> {
        Box::pin(async move {
            let mut c = conn(&self.ingest.db, company).await?;
            let rows = pages::list(&mut c).await.map_err(port_err)?;
            Ok(rows
                .into_iter()
                .map(|p| PageRef {
                    page_id: p.page_id,
                    name: p.name,
                    is_active: p.is_active,
                })
                .collect())
        })
    }
}

// ------------------------------------------------------------------ bình luận (M49)

struct CommentsAdapter {
    ingest: Arc<FacebookIngest>,
}

impl CommentsAdapter {
    fn body(input: &Map<String, Value>) -> Result<Map<String, Value>, ToolError> {
        comments::validate_rule_body(&Value::Object(input.clone())).map_err(|e| port_err(AppError::from(e)))
    }
}

impl CommentsPort for CommentsAdapter {
    fn list_comments(&self, company: CompanyRef, q: CommentQuery) -> PortFut<'_, Vec<Value>> {
        Box::pin(async move {
            // Dịch vụ không có `since`: lấy trang mới nhất (≤100) rồi lọc; danh sách xếp mới nhất trước nên kết quả y như lọc ở SQL.
            let lq = ListQuery {
                limit: 100,
                status: q.status.clone(),
                unanswered: false,
            };
            let mut c = conn(&self.ingest.db, company).await?;
            let rows = comments::list_comments(&mut c, &lq, Utc::now())
                .await
                .map_err(port_err)?;
            drop(c);
            let kept: Vec<Value> = rows.into_iter().filter(|r| created_since(r, q.since)).collect();
            Ok(take_rows(kept, q.limit.clamp(1, 100)))
        })
    }

    fn list_rules(&self, company: CompanyRef) -> PortFut<'_, Vec<Value>> {
        Box::pin(async move {
            let mut c = conn(&self.ingest.db, company).await?;
            let rules = comments::list_rules(&mut c).await.map_err(port_err)?;
            rules.iter().map(to_json).collect()
        })
    }

    fn create_rule(&self, company: CompanyRef, user_id: i32, input: Map<String, Value>) -> PortFut<'_, Value> {
        Box::pin(async move {
            let body = Self::body(&input)?;
            let mut c = conn(&self.ingest.db, company).await?;
            let rule = comments::create_rule(&mut c, &body, user_id).await.map_err(port_err)?;
            to_json(&rule)
        })
    }

    fn update_rule(&self, company: CompanyRef, id: i32, input: Map<String, Value>) -> PortFut<'_, Value> {
        Box::pin(async move {
            let body = Self::body(&input)?;
            let mut c = conn(&self.ingest.db, company).await?;
            let rule = comments::update_rule(&mut c, id, &body).await.map_err(port_err)?;
            to_json(&rule)
        })
    }

    fn dry_run(&self, company: CompanyRef, input: Value) -> PortFut<'_, Value> {
        Box::pin(async move {
            let dto = DryRunInput::from_json(&input).map_err(|e| port_err(AppError::from(e)))?;
            let mut c = conn(&self.ingest.db, company).await?;
            comments::dry_run(&mut c, &dto).await.map_err(port_err)
        })
    }

    fn normalize_post_id(&self, raw: &str, page_id: Option<&str>) -> Result<Option<String>, ToolError> {
        normalize_post(raw, page_id)
    }
}

// ------------------------------------------------------------------ link chat (M50 phần 1)

struct ChatLinksAdapter {
    ingest: Arc<FacebookIngest>,
    multi_tenant: bool,
}

impl ChatLinksAdapter {
    fn urls(&self, company: CompanyRef) -> LinkUrls {
        LinkUrls::from_env(&self.ingest.env, self.multi_tenant, company)
    }
}

impl ChatLinksPort for ChatLinksAdapter {
    fn list(&self, company: CompanyRef) -> PortFut<'_, Vec<Value>> {
        Box::pin(async move {
            let urls = self.urls(company);
            let mut c = conn(&self.ingest.db, company).await?;
            let v = chat_links::list(&mut c, &urls).await.map_err(port_err)?;
            Ok(data_rows(v))
        })
    }

    fn create(&self, company: CompanyRef, user_id: i32, input: Value) -> PortFut<'_, Value> {
        Box::pin(async move {
            let dto = ChatLinkInput::from_json(&input).map_err(|e| port_err(AppError::from(e)))?;
            let urls = self.urls(company);
            let mut c = conn(&self.ingest.db, company).await?;
            chat_links::create(&mut c, &dto, user_id, &urls).await.map_err(port_err)
        })
    }
}

// ------------------------------------------------------------------ hướng dẫn quản trị viên Page

struct AdminGuideAdapter {
    ingest: Arc<FacebookIngest>,
}

impl AdminGuidePort for AdminGuideAdapter {
    fn compose<'a>(
        &'a self,
        company: CompanyRef,
        page_id: &'a str,
        recipient: Option<String>,
        note: Option<String>,
    ) -> PortFut<'a, Value> {
        Box::pin(async move {
            // Cùng kiểm độ dài (UTF-16) và cắt khoảng trắng như route REST: inputSchema `maxLength` không được máy chủ ép.
            let input = GuideInput::from_json(&serde_json::json!({ "recipient": recipient, "note": note }))
                .map_err(|e| port_err(e.into()))?;
            let mut c = conn(&self.ingest.db, company).await?;
            let g = admin_guide::build(&mut c, PageKey::FacebookId(page_id), &input, &self.ingest.env)
                .await
                .map_err(port_err)?;
            to_json(&g)
        })
    }
}

// ------------------------------------------------------------------ gửi hàng loạt (M51)

struct FlowsAdapter {
    ingest: Arc<FacebookIngest>,
}

fn flow_input(v: Value) -> Result<FlowInput, ToolError> {
    FlowInput::from_json(&v).map_err(|e| port_err(e.into()))
}

impl FlowsPort for FlowsAdapter {
    fn list(&self, company: CompanyRef) -> PortFut<'_, Vec<Value>> {
        Box::pin(async move { self.ingest.list_flows(company).await.map_err(port_err) })
    }

    fn create(&self, company: CompanyRef, user_id: i32, input: Value) -> PortFut<'_, Value> {
        Box::pin(async move {
            let input = flow_input(input)?;
            self.ingest
                .create_flow(company, &input, user_id)
                .await
                .map_err(port_err)
        })
    }

    fn update(&self, company: CompanyRef, id: i32, input: Map<String, Value>) -> PortFut<'_, Value> {
        Box::pin(async move {
            let input = flow_input(Value::Object(input))?;
            self.ingest.update_flow(company, id, &input).await.map_err(port_err)
        })
    }
}

struct BroadcastsAdapter {
    ingest: Arc<FacebookIngest>,
    kick: Option<Kick>,
}

fn broadcast_input(v: &Value) -> Result<BroadcastInput, ToolError> {
    BroadcastInput::from_json(v).map_err(|e| port_err(AppError::from(e)))
}

impl BroadcastsPort for BroadcastsAdapter {
    fn list(&self, company: CompanyRef, limit: i64) -> PortFut<'_, Vec<Value>> {
        Box::pin(async move {
            let v = self.ingest.list_broadcasts(company).await.map_err(port_err)?;
            Ok(take_rows(data_rows(v), limit))
        })
    }

    fn recipients(&self, company: CompanyRef, id: i32, limit: i64) -> PortFut<'_, Vec<Value>> {
        Box::pin(async move {
            let v = self.ingest.broadcast_recipients(company, id).await.map_err(port_err)?;
            Ok(take_rows(data_rows(v), limit))
        })
    }

    fn get(&self, company: CompanyRef, id: i32) -> PortFut<'_, Value> {
        Box::pin(async move { self.ingest.get_broadcast(company, id).await.map_err(port_err) })
    }

    fn validate(&self, company: CompanyRef, input: &Value, partial: bool) -> PortFut<'_, ()> {
        let parsed = broadcast_input(input);
        Box::pin(async move {
            self.ingest
                .check_broadcast(company, &parsed?, partial)
                .await
                .map_err(port_err)
        })
    }

    fn check_send_time(&self, at: Option<DateTime<Utc>>) -> Result<(), ToolError> {
        check_send_at(at, Utc::now())
    }

    fn preview<'a>(&'a self, company: CompanyRef, page_id: &'a str, audience: &'a Value) -> PortFut<'a, Value> {
        Box::pin(async move {
            let aud = Audience::from_value(audience);
            self.ingest
                .preview_broadcast(company, page_id, &aud, Utc::now())
                .await
                .map_err(port_err)
        })
    }

    fn create<'a>(
        &'a self,
        company: CompanyRef,
        user_id: i32,
        input: &'a Value,
        source: &'a str,
    ) -> PortFut<'a, Value> {
        Box::pin(async move {
            let dto = broadcast_input(input)?;
            self.ingest
                .create_broadcast(company, &dto, user_id, source)
                .await
                .map_err(port_err)
        })
    }

    fn update(&self, company: CompanyRef, id: i32, input: Map<String, Value>) -> PortFut<'_, Value> {
        Box::pin(async move {
            let dto = broadcast_input(&Value::Object(input))?;
            self.ingest.update_broadcast(company, id, &dto).await.map_err(port_err)
        })
    }

    fn send(&self, company: CompanyRef, id: i32, at: Option<DateTime<Utc>>) -> PortFut<'_, Value> {
        Box::pin(async move {
            let iso = at.map(js_iso_string);
            let guard = self.ingest.guard.as_deref();
            self.ingest
                .send_broadcast(company, guard, id, iso.as_deref(), Utc::now())
                .await
                .map_err(port_err)
        })
    }

    fn kick(&self) {
        if let Some(k) = &self.kick {
            k();
        }
    }

    /// Chỉ huỷ lượt đang chờ giờ gửi (`scheduled`); lượt nháp/đang gửi/đã xong ⇒ lỗi người dùng. Lượt vừa chuyển sang `sending`
    /// giữa lúc kiểm và huỷ thì dịch vụ dừng lượt đó (người chưa gửi ghi "bỏ qua"), giống nút Huỷ ở giao diện.
    fn cancel_pending(&self, company: CompanyRef, id: i32) -> PortFut<'_, Value> {
        Box::pin(async move {
            let b = self.ingest.get_broadcast(company, id).await.map_err(port_err)?;
            if status_of(&b) != "scheduled" {
                return Err(ToolError::User(
                    "Chỉ huỷ được lượt đang chờ tới giờ gửi. / Only broadcasts waiting for their send time can be cancelled."
                        .to_owned(),
                ));
            }
            self.ingest.cancel_broadcast(company, id).await.map_err(port_err)
        })
    }
}

// ------------------------------------------------------------------ bài hẹn giờ (M54a)

struct PostsAdapter {
    db: Db,
    env: Env,
    deps: PostsDeps,
}

impl ScheduledPostsPort for PostsAdapter {
    fn get(&self, company: CompanyRef, id: i32) -> PortFut<'_, Value> {
        Box::pin(async move {
            let mut c = conn(&self.db, company).await?;
            let post = posts::get(&mut c, id).await.map_err(port_err)?;
            to_json(&post)
        })
    }

    fn cancel(&self, company: CompanyRef, id: i32) -> PortFut<'_, Value> {
        Box::pin(async move {
            let graph = (self.deps.graph_for)(company);
            // `cancel` chỉ đọc/ghi DB (huỷ kênh `queued`/`failed` rồi tính lại trạng thái): `user_id` không được dùng.
            let ctx = PostCtx {
                db: &self.db,
                company,
                env: &self.env,
                store: &self.deps.store,
                graph: &graph,
                guard: &self.deps.guard,
                user_id: 0,
                now_ms: Utc::now().timestamp_millis(),
            };
            let post = posts::cancel(&ctx, id).await.map_err(port_err)?;
            to_json(&post)
        })
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use serde_json::json;
    use trinity_kernel::error::HttpError;

    use super::*;

    fn at(h: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 27, h, 0, 0).unwrap()
    }

    fn user_msg(e: ToolError) -> String {
        match e {
            ToolError::User(m) => m,
            other => panic!("cần ToolError::User, được {other:?}"),
        }
    }

    #[test]
    fn loi_400_404_thanh_cau_nguyen_van_cho_ai() {
        let m = user_msg(port_err(HttpError::bad_request("Nội dung tối đa 2000 ký tự.").into()));
        assert_eq!(m, "Nội dung tối đa 2000 ký tự.");
        let m = user_msg(port_err(HttpError::not_found("Không tìm thấy lượt gửi.").into()));
        assert_eq!(m, "Không tìm thấy lượt gửi.");
        let m = user_msg(port_err(
            HttpError::validation(vec!["a sai".to_owned(), "b sai".to_owned()]).into(),
        ));
        assert_eq!(m, "a sai; b sai");
    }

    #[test]
    fn loi_khac_di_qua_app_err() {
        assert!(matches!(
            port_err(HttpError::forbidden("không được").into()),
            ToolError::Http { status: 403, .. }
        ));
        assert!(matches!(
            port_err(HttpError::conflict("trùng").into()),
            ToolError::Http { status: 409, .. }
        ));
        assert!(matches!(
            port_err(AppError::internal("hỏng")),
            ToolError::Http { status: 500, .. }
        ));
    }

    #[test]
    fn lay_hang_trong_data_va_cat_theo_limit() {
        let rows = data_rows(json!({ "data": [{ "id": 1 }, { "id": 2 }, { "id": 3 }] }));
        assert_eq!(rows.len(), 3);
        assert_eq!(take_rows(rows.clone(), 2), vec![json!({ "id": 1 }), json!({ "id": 2 })]);
        assert!(take_rows(rows, 0).is_empty());
        assert!(data_rows(json!({ "data": "x" })).is_empty());
        assert!(data_rows(json!([1, 2])).is_empty());
    }

    #[test]
    fn loc_binh_luan_theo_since_gom_ca_moc() {
        let since = at(10);
        let row = |t: &str| json!({ "created_at": t });
        assert!(created_since(&row("2026-11-27T10:00:00.000Z"), since));
        assert!(created_since(&row("2026-11-27T11:30:00.000Z"), since));
        assert!(!created_since(&row("2026-11-27T09:59:59.999Z"), since));
        assert!(!created_since(&json!({}), since));
        assert!(!created_since(&row("khong-phai-gio"), since));
    }

    #[test]
    fn gio_hen_toi_da_7_ngay() {
        let now = at(8);
        assert!(check_send_at(None, now).is_ok());
        assert!(check_send_at(Some(at(7)), now).is_ok()); // đã qua = gửi ngay
        assert!(check_send_at(Some(now + chrono::Duration::days(7)), now).is_ok());
        let m = user_msg(check_send_at(Some(now + chrono::Duration::days(8)), now).unwrap_err());
        assert!(m.starts_with("Hẹn tối đa 7 ngày tới"), "{m}");
    }

    #[test]
    fn trang_thai_thieu_la_chuoi_rong() {
        assert_eq!(status_of(&json!({ "status": "scheduled" })), "scheduled");
        assert_eq!(status_of(&json!({})), "");
    }

    #[test]
    fn post_id_chuan_hoa_va_link_hong() {
        assert_eq!(
            normalize_post("123456_7890123", None).unwrap(),
            Some("123456_7890123".to_owned())
        );
        assert_eq!(
            normalize_post("https://www.facebook.com/page/posts/7890123", Some("55555")).unwrap(),
            Some("55555_7890123".to_owned())
        );
        assert_eq!(normalize_post("  ", None).unwrap(), None);
        // Có số bài nhưng không biết Page ⇒ 400 thành câu cho AI.
        let m = user_msg(normalize_post("https://www.facebook.com/page/posts/7890123", None).unwrap_err());
        assert!(m.starts_with("Không đọc được bài từ link này"), "{m}");
    }
}
