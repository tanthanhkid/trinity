//! Bảng route của M16 (K14): 17 route thẻ, checklist và đính kèm; mỗi route khai `Access` bắt buộc, so với
//! `contracts/routes.json` ở test cuối file và ở `trinity check-routes`.

#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::Json;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use http::Method;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use trinity_db::models::{KanbanCardAttachment, KanbanChecklistItem};
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::{Dto, ValidJson, ValidQuery};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::{Grants, OwnerIds, ScopeService, can};

use crate::activities::{self, ActivityDto, CreateComment};
use crate::attachments::{self, CreateAttachment};
use crate::cards::{self, CardDto, CardList, CreateCard, ListCards, MoveCard, Moved, Removed, Restored, UpdateCard};
use crate::checklist::{self, CreateItem, ReorderItems, UpdateItem};
use crate::{Actor, Deleted, db};

const ID: &[&str] = &["param.id:ParseIntPipe"];
const CARD_ID: &[&str] = &["param.cardId:ParseIntPipe"];

/// 17 route của `KanbanCardsController`, `KanbanChecklistController` và `KanbanAttachmentsController`.
pub fn routes() -> Vec<RouteSpec> {
    let view = Access::Can(&["kanban.view"]);
    let manage = Access::Can(&["kanban.manage"]);
    vec![
        RouteSpec::new(Method::GET, "/api/v1/kanban/cards", view).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/kanban/cards", manage).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/kanban/cards/:id", view)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::PATCH, "/api/v1/kanban/cards/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/kanban/cards/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/cards/:id/move", manage)
            .status_ok(201)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/cards/:id/restore", manage)
            .status_ok(201)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/kanban/cards/:id/activities", view)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/cards/:id/comments", manage)
            .status_ok(201)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/kanban/cards/:cardId/checklist-items", view)
            .status_ok(200)
            .param_pipes(CARD_ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/cards/:cardId/checklist-items", manage)
            .status_ok(201)
            .param_pipes(CARD_ID),
        RouteSpec::new(
            Method::POST,
            "/api/v1/kanban/cards/:cardId/checklist-items/reorder",
            manage,
        )
        .status_ok(201)
        .param_pipes(CARD_ID),
        RouteSpec::new(Method::PATCH, "/api/v1/kanban/checklist-items/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/kanban/checklist-items/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/kanban/cards/:cardId/attachments", view)
            .status_ok(200)
            .param_pipes(CARD_ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/cards/:cardId/attachments", manage)
            .status_ok(201)
            .param_pipes(CARD_ID),
        RouteSpec::new(Method::DELETE, "/api/v1/kanban/attachments/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
    ]
}

/// Phụ thuộc của handler: kết nối DB theo công ty và dịch vụ phạm vi (K13).
pub struct Ctx {
    pub db: Db,
    pub scopes: ScopeService,
}

impl Ctx {
    async fn conn(&self, company: CompanyRef) -> Result<TenantConn, AppError> {
        let tenant = self.db.tenant(company).await.map_err(AppError::internal)?;
        tenant.acquire().await.map_err(AppError::internal)
    }

    async fn owner(&self, w: &Who, perm: &str) -> Result<Option<OwnerIds>, AppError> {
        self.scopes
            .owner_ids(w.company, w.user_id, &w.grants, perm)
            .await
            .map_err(AppError::internal)
    }

    /// `loadKanbanAccessContext` + quyền Danh bạ. Mượn một kết nối ngắn để đọc vai trò rồi trả NGAY: gọi hàm này TRƯỚC khi
    /// giữ kết nối của handler (không giữ hai kết nối của pool cùng lúc).
    async fn actor_of(&self, w: &Who) -> Result<Actor, AppError> {
        let card_owner = self.owner(w, "kanban.view").await?;
        let contact_view = self.owner(w, "contacts.view").await?;
        let contact_phone_full = self.owner(w, "contacts.phone_full").await?;
        let role_ids: Vec<i32> = {
            let mut conn = self.conn(w.company).await?;
            sqlx::query_scalar("SELECT role_id FROM user_roles WHERE user_id = $1")
                .bind(w.user_id)
                .fetch_all(&mut *conn)
                .await
                .map_err(db)?
        };
        Ok(Actor {
            user_id: w.user_id,
            is_admin: w.is_admin,
            access: crate::Access {
                can_manage_boards: can(&w.grants, "kanban.boards", None),
                role_ids,
            },
            card_owner,
            can_view_contacts: can(&w.grants, "contacts.view", None),
            contact_view,
            contact_phone_full,
        })
    }

    /// Người gọi cùng kết nối đã gắn công ty.
    async fn open(&self, u: &CurrentUser) -> Result<(Actor, TenantConn), AppError> {
        let w = Who::of(u)?;
        let actor = self.actor_of(&w).await?;
        let conn = self.conn(w.company).await?;
        Ok((actor, conn))
    }
}

/// Người gọi đã xác thực.
struct Who {
    user_id: i32,
    company: CompanyRef,
    grants: Grants,
    is_admin: bool,
}

impl Who {
    /// Công ty của token không hợp lệ ⇒ 401 (đóng, KHÔNG rơi về công ty mặc định).
    fn of(u: &CurrentUser) -> Result<Self, AppError> {
        let company = CompanyRef::new(i64::from(u.user.company_id))
            .map_err(|_| HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn"))?;
        Ok(Self {
            user_id: u.user.user_id,
            company,
            grants: u.grants.grants.clone(),
            is_admin: u.grants.is_admin,
        })
    }
}

fn fail(e: impl Into<AppError>) -> Response {
    let (status, body) = e.into().response(true);
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}

fn ok<T: Serialize>(r: Result<T, AppError>) -> Response {
    match r {
        Ok(v) => match serde_json::to_string(&v) {
            Ok(text) => {
                let mut resp = Response::new(Body::from(text));
                resp.headers_mut().insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/json; charset=utf-8"),
                );
                resp
            }
            Err(e) => fail(AppError::internal(e)),
        },
        Err(e) => fail(e),
    }
}

/// `ParseIntPipe` đã chạy ở router: số ngoài khoảng int4 thì không có bản ghi nào ⇒ 404 như service.
fn id_of(raw: &str, what: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found(format!("Không tìm thấy {what} ID {raw}")).into())
}

/// Body JSON như `body-parser` của Express: không phải JSON hoặc rỗng ⇒ `{}`.
struct JsonBody(Value);

impl<S: Send + Sync> FromRequest<S> for JsonBody {
    type Rejection = Response;

    async fn from_request(req: Request, _s: &S) -> Result<Self, Response> {
        let is_json = req
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| {
                ct.split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("application/json")
            });
        let bytes: Bytes = to_bytes(req.into_body(), 5 * 1024 * 1024)
            .await
            .map_err(|_| fail(HttpError::payload_too_large("request entity too large")))?;
        if !is_json || bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Self(Value::Object(Map::new())));
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(v @ (Value::Object(_) | Value::Array(_))) => Ok(Self(v)),
            _ => Err(fail(HttpError::bad_request("Unexpected token in JSON"))),
        }
    }
}

impl Dto for CreateCard {
    const NAME: &'static str = "CreateKanbanCardDto";
}

impl Dto for ListCards {
    const NAME: &'static str = "QueryKanbanCardsDto";
}

/// Một trường bắt buộc/không nhận `null` của DTO kiểm tay: (khoá, các câu lỗi theo thứ tự class-validator khi thiếu hoặc
/// `null`, bắt buộc có mặt).
type Check = (&'static str, &'static [&'static str], bool);

const T_MAX: &str = "text tối đa 500 ký tự";
const T_MIN: &str = "text không được rỗng";
const T_STR: &str = "text phải là chuỗi";
const C_MAX: &str = "content tối đa 5000 ký tự";
const C_MIN: &str = "content không được rỗng";
const C_STR: &str = "content phải là chuỗi";
const I_INT: &str = "item_ids chỉ chứa số nguyên";
const I_MAX: &str = "item_ids tối đa 200 phần tử";
const I_MIN: &str = "item_ids không được rỗng";
const I_ARR: &str = "item_ids phải là mảng";
const U_MAX: &str = "url tối đa 2000 ký tự";
const U_URL: &str = "url phải là đường dẫn http/https hợp lệ";
const M_MIN: &str = "column_id không hợp lệ";
const M_INT: &str = "column_id phải là số nguyên";

const TEXT_500: Check = ("text", &[T_MAX, T_MIN, T_STR], true);
const COMMENT_CONTENT: Check = ("content", &[C_MAX, C_MIN, C_STR], true);
const ITEM_IDS: Check = ("item_ids", &[I_INT, I_MAX, I_MIN, I_ARR], true);
const ATTACHMENT_URL: Check = ("url", &[U_MAX, U_URL], true);
const MOVE_COLUMN: Check = ("column_id", &[M_MIN, M_INT], true);
const ITEM_TEXT_NOT_NULL: Check = ("text", &[T_MAX, T_MIN, T_STR], false);
const ITEM_DONE_NOT_NULL: Check = ("is_done", &["is_done phải là boolean"], false);

/// Body của DTO không có trong `schema.json`: trường lạ ⇒ 400 `property x should not exist` (strict), trường bắt buộc vắng
/// hoặc `null` ⇒ câu lỗi của class-validator, còn lại đưa serde nhận (kiểu sai ⇒ 400 `Bad Request`).
fn parse_body<T: DeserializeOwned>(body: &Value, allowed: &[&str], checks: &[Check]) -> Result<T, AppError> {
    let empty = Map::new();
    let obj = body.as_object().unwrap_or(&empty);
    let mut e: Vec<String> = obj
        .keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .map(|k| format!("property {k} should not exist"))
        .collect();
    for (key, msgs, required) in checks {
        let bad = match obj.get(*key) {
            Some(Value::Null) => true,
            None => *required,
            Some(_) => false,
        };
        if bad {
            e.extend(msgs.iter().map(|m| (*m).to_owned()));
        }
    }
    if !e.is_empty() {
        return Err(HttpError::validation(e).into());
    }
    serde_json::from_value(Value::Object(obj.clone()))
        .map_err(|_| HttpError::nest(400, None).into())
}

const UPDATE_CARD_KEYS: [&str; 10] = [
    "title",
    "description",
    "contact_id",
    "assignee_id",
    "assignee_ids",
    "due_at",
    "due_completed_at",
    "priority",
    "labels",
    "attributes",
];

type S = State<Arc<Ctx>>;
type U = Extension<CurrentUser>;

async fn list_inner(c: &Ctx, u: &CurrentUser, q: &ListCards) -> Result<CardList, AppError> {
    let (actor, mut conn) = c.open(u).await?;
    cards::list(&mut conn, &actor, q).await
}

async fn list(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<ListCards>) -> Response {
    ok(list_inner(&c, &u, &q).await)
}

async fn create_inner(c: &Ctx, u: &CurrentUser, dto: &CreateCard) -> Result<CardDto, AppError> {
    let (actor, mut conn) = c.open(u).await?;
    cards::create(&mut conn, &actor, dto).await
}

async fn create(State(c): S, Extension(u): U, ValidJson(dto): ValidJson<CreateCard>) -> Response {
    ok(create_inner(&c, &u, &dto).await)
}

async fn get_one_inner(c: &Ctx, u: &CurrentUser, raw: &str) -> Result<CardDto, AppError> {
    let id = id_of(raw, "card")?;
    let (actor, mut conn) = c.open(u).await?;
    cards::find_one(&mut conn, &actor, id).await
}

async fn get_one(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    ok(get_one_inner(&c, &u, &id).await)
}

async fn update_inner(c: &Ctx, u: &CurrentUser, raw: &str, body: &Value) -> Result<CardDto, AppError> {
    let dto: UpdateCard = parse_body(body, &UPDATE_CARD_KEYS, &[])?;
    let id = id_of(raw, "card")?;
    let (actor, mut conn) = c.open(u).await?;
    cards::update(&mut conn, &actor, id, &dto).await
}

async fn update(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    ok(update_inner(&c, &u, &id, &body).await)
}

async fn remove_inner(c: &Ctx, u: &CurrentUser, raw: &str) -> Result<Removed, AppError> {
    let id = id_of(raw, "card")?;
    let (actor, mut conn) = c.open(u).await?;
    cards::remove(&mut conn, &actor, id).await
}

async fn remove(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    ok(remove_inner(&c, &u, &id).await)
}

async fn move_inner(c: &Ctx, u: &CurrentUser, raw: &str, body: &Value) -> Result<Moved, AppError> {
    let dto: MoveCard = parse_body(body, &["column_id", "before_card_id", "after_card_id"], &[MOVE_COLUMN])?;
    let id = id_of(raw, "card")?;
    let (actor, mut conn) = c.open(u).await?;
    cards::move_card(&mut conn, &actor, id, &dto).await
}

async fn move_card(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    ok(move_inner(&c, &u, &id, &body).await)
}

async fn restore_inner(c: &Ctx, u: &CurrentUser, raw: &str) -> Result<Restored, AppError> {
    let id = id_of(raw, "card")?;
    let (actor, mut conn) = c.open(u).await?;
    cards::restore(&mut conn, &actor, id).await
}

async fn restore(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    ok(restore_inner(&c, &u, &id).await)
}

async fn card_activities_inner(c: &Ctx, u: &CurrentUser, raw: &str) -> Result<Vec<ActivityDto>, AppError> {
    let id = id_of(raw, "card")?;
    let (actor, mut conn) = c.open(u).await?;
    activities::list(&mut conn, &actor, id).await
}

async fn card_activities(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    ok(card_activities_inner(&c, &u, &id).await)
}

async fn comment_inner(c: &Ctx, u: &CurrentUser, raw: &str, body: &Value) -> Result<ActivityDto, AppError> {
    let dto: CreateComment = parse_body(body, &["content"], &[COMMENT_CONTENT])?;
    dto.validate()?;
    let id = id_of(raw, "card")?;
    let (actor, mut conn) = c.open(u).await?;
    activities::add_comment(&mut conn, &actor, id, &dto).await
}

async fn comment(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    ok(comment_inner(&c, &u, &id, &body).await)
}

async fn items_list_inner(c: &Ctx, u: &CurrentUser, raw: &str) -> Result<Vec<KanbanChecklistItem>, AppError> {
    let id = id_of(raw, "card")?;
    let (actor, mut conn) = c.open(u).await?;
    checklist::list(&mut conn, &actor, id).await
}

async fn items_list(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    ok(items_list_inner(&c, &u, &id).await)
}

async fn item_create_inner(c: &Ctx, u: &CurrentUser, raw: &str, body: &Value) -> Result<KanbanChecklistItem, AppError> {
    let dto: CreateItem = parse_body(body, &["text"], &[TEXT_500])?;
    dto.validate()?;
    let id = id_of(raw, "card")?;
    let (actor, mut conn) = c.open(u).await?;
    checklist::create(&mut conn, &actor, id, &dto).await
}

async fn item_create(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    ok(item_create_inner(&c, &u, &id, &body).await)
}

async fn items_reorder_inner(
    c: &Ctx,
    u: &CurrentUser,
    raw: &str,
    body: &Value,
) -> Result<Vec<KanbanChecklistItem>, AppError> {
    let dto: ReorderItems = parse_body(body, &["item_ids"], &[ITEM_IDS])?;
    dto.validate()?;
    let id = id_of(raw, "card")?;
    let (actor, mut conn) = c.open(u).await?;
    checklist::reorder(&mut conn, &actor, id, &dto).await
}

async fn items_reorder(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    ok(items_reorder_inner(&c, &u, &id, &body).await)
}

async fn item_update_inner(c: &Ctx, u: &CurrentUser, raw: &str, body: &Value) -> Result<KanbanChecklistItem, AppError> {
    let dto: UpdateItem = parse_body(body, &["text", "is_done"], &[ITEM_TEXT_NOT_NULL, ITEM_DONE_NOT_NULL])?;
    dto.validate()?;
    let id = id_of(raw, "mục checklist")?;
    let (actor, mut conn) = c.open(u).await?;
    checklist::update(&mut conn, &actor, id, &dto).await
}

async fn item_update(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    ok(item_update_inner(&c, &u, &id, &body).await)
}

async fn item_remove_inner(c: &Ctx, u: &CurrentUser, raw: &str) -> Result<Deleted, AppError> {
    let id = id_of(raw, "mục checklist")?;
    let (actor, mut conn) = c.open(u).await?;
    checklist::remove(&mut conn, &actor, id).await
}

async fn item_remove(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    ok(item_remove_inner(&c, &u, &id).await)
}

async fn files_list_inner(c: &Ctx, u: &CurrentUser, raw: &str) -> Result<Vec<KanbanCardAttachment>, AppError> {
    let id = id_of(raw, "card")?;
    let (actor, mut conn) = c.open(u).await?;
    attachments::list(&mut conn, &actor, id).await
}

async fn files_list(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    ok(files_list_inner(&c, &u, &id).await)
}

async fn file_create_inner(
    c: &Ctx,
    u: &CurrentUser,
    raw: &str,
    body: &Value,
) -> Result<KanbanCardAttachment, AppError> {
    let dto: CreateAttachment = parse_body(body, &["url", "title"], &[ATTACHMENT_URL])?;
    dto.validate()?;
    let id = id_of(raw, "card")?;
    let (actor, mut conn) = c.open(u).await?;
    attachments::create(&mut conn, &actor, id, &dto).await
}

async fn file_create(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    ok(file_create_inner(&c, &u, &id, &body).await)
}

async fn file_remove_inner(c: &Ctx, u: &CurrentUser, raw: &str) -> Result<Deleted, AppError> {
    let id = id_of(raw, "đính kèm")?;
    let (actor, mut conn) = c.open(u).await?;
    attachments::remove(&mut conn, &actor, id).await
}

async fn file_remove(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    ok(file_remove_inner(&c, &u, &id).await)
}

/// Router của module: mọi route đi qua `ApiRouter` (khai quyền bắt buộc). Người gọi gắn state `Arc<Ctx>` khi lắp `serve`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = routes();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    let list_path = "/api/v1/kanban/cards";
    let card_path = "/api/v1/kanban/cards/:id";
    let items_path = "/api/v1/kanban/cards/:cardId/checklist-items";
    let files_path = "/api/v1/kanban/cards/:cardId/attachments";
    ApiRouter::new(deps)
        .route(spec(&Method::GET, list_path), list)
        .route(spec(&Method::POST, list_path), create)
        .route(spec(&Method::GET, card_path), get_one)
        .route(spec(&Method::PATCH, card_path), update)
        .route(spec(&Method::DELETE, card_path), remove)
        .route(spec(&Method::POST, "/api/v1/kanban/cards/:id/move"), move_card)
        .route(spec(&Method::POST, "/api/v1/kanban/cards/:id/restore"), restore)
        .route(spec(&Method::GET, "/api/v1/kanban/cards/:id/activities"), card_activities)
        .route(spec(&Method::POST, "/api/v1/kanban/cards/:id/comments"), comment)
        .route(spec(&Method::GET, items_path), items_list)
        .route(spec(&Method::POST, items_path), item_create)
        .route(
            spec(&Method::POST, "/api/v1/kanban/cards/:cardId/checklist-items/reorder"),
            items_reorder,
        )
        .route(spec(&Method::PATCH, "/api/v1/kanban/checklist-items/:id"), item_update)
        .route(spec(&Method::DELETE, "/api/v1/kanban/checklist-items/:id"), item_remove)
        .route(spec(&Method::GET, files_path), files_list)
        .route(spec(&Method::POST, files_path), file_create)
        .route(spec(&Method::DELETE, "/api/v1/kanban/attachments/:id"), file_remove)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 17);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 17);
    }
}
