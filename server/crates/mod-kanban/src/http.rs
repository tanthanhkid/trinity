//! Handler và router axum của Kanban (K14): 35 route `/api/v1/kanban/*` (18 route bảng/cột/nhãn/trường ở
//! [`routes::board_routes`], 17 route thẻ/checklist/đính kèm ở [`routes::routes`]).
//!
//! Handler chỉ làm: dựng người gọi → đọc body/query (K15 cho `CreateKanbanCardDto`/`QueryKanbanCardsDto`; các DTO còn lại chưa có
//! trong `schema.json` nên kiểm tay: khoá lạ ⇒ `property x should not exist`, rồi `validate()` của từng DTO) → hàm nghiệp vụ → JSON.
//! Mã thành công (200/201) do lớp thực thi của `ApiRouter` đặt theo `RouteSpec::status_ok`.
//!
//! Đính kèm là DẠNG LIÊN KẾT (`url` + `title` trong JSON, [`attachments`]) như bản TS: không có multipart ở module này.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Query, Request, State};
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_http::router::{AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::{Dto, ValidJson, ValidQuery};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::{ScopeService, can};

use crate::activities::CreateComment;
use crate::attachments::CreateAttachment;
use crate::boards::{CreateBoard, CreateBoardFromTemplate, UpdateBoard};
use crate::cards::{CreateCard, ListCards, MoveCard, UpdateCard};
use crate::checklist::{CreateItem, ReorderItems, UpdateItem};
use crate::columns::{CreateColumn, ReorderColumns, UpdateColumn};
use crate::field_defs::{CreateFieldDef, ReorderFieldDefs, UpdateFieldDef};
use crate::labels::{CreateLabel, UpdateLabel};
use crate::{Access, Actor, activities, attachments, boards, cards, checklist, columns, field_defs, labels, routes};

/// Trạng thái dùng chung của router Kanban.
pub struct Ctx {
    pub db: Db,
    pub scopes: ScopeService,
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
        Ok(v) => Json(v).into_response(),
        Err(e) => fail(e),
    }
}

fn company_of(u: &CurrentUser) -> Result<CompanyRef, AppError> {
    CompanyRef::new(i64::from(u.user.company_id))
        .map_err(|_| HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn").into())
}

async fn conn(c: &Ctx, company: CompanyRef) -> Result<TenantConn, AppError> {
    let t = c.db.tenant(company).await.map_err(AppError::internal)?;
    t.acquire().await.map_err(AppError::internal)
}

/// `Access` của người gọi (vai trò đọc bằng một kết nối ngắn, trả NGAY trước khi giữ kết nối của handler).
async fn access_of(c: &Ctx, company: CompanyRef, u: &CurrentUser) -> Result<Access, AppError> {
    let role_ids: Vec<i32> = {
        let mut cn = conn(c, company).await?;
        sqlx::query_scalar("SELECT role_id FROM user_roles WHERE user_id = $1")
            .bind(u.user.user_id)
            .fetch_all(&mut *cn)
            .await
            .map_err(AppError::internal)?
    };
    Ok(Access {
        can_manage_boards: can(&u.grants.grants, "kanban.boards", None),
        role_ids,
    })
}

/// Người gọi cho thao tác trên thẻ: [`Access`] cộng phạm vi `kanban.view` và quyền Danh bạ.
async fn actor_of(c: &Ctx, company: CompanyRef, u: &CurrentUser) -> Result<Actor, AppError> {
    let grants = &u.grants.grants;
    let user = u.user.user_id;
    let owner = |perm: &'static str| async move {
        c.scopes
            .owner_ids(company, user, grants, perm)
            .await
            .map_err(AppError::internal)
    };
    let card_owner = owner("kanban.view").await?;
    let contact_view = owner("contacts.view").await?;
    let contact_phone_full = owner("contacts.phone_full").await?;
    Ok(Actor {
        user_id: user,
        is_admin: u.grants.is_admin,
        access: access_of(c, company, u).await?,
        card_owner,
        can_view_contacts: can(grants, "contacts.view", None),
        contact_view,
        contact_phone_full,
    })
}

/// `ParseIntPipe` đã chạy ở router: số ngoài int4 thì không có bản ghi nào.
fn id_of(raw: &str, what: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::not_found(format!("Không tìm thấy {what}")).into())
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

/// DTO trong `schema.json` (K15 kiểm đủ luật, kể cả khoá lạ).
#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct QueryKanbanCardsDto(ListCards);

impl Dto for QueryKanbanCardsDto {
    const NAME: &'static str = "QueryKanbanCardsDto";
}

#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct CreateKanbanCardDto(CreateCard);

impl Dto for CreateKanbanCardDto {
    const NAME: &'static str = "CreateKanbanCardDto";
}

/// `forbidNonWhitelisted`: khoá lạ ⇒ 400 trước mọi luật của từng thuộc tính; kiểu sai ⇒ 400 trơn.
fn strict<T: DeserializeOwned>(body: Value, known: &[&str]) -> Result<T, AppError> {
    let unknown: Vec<String> = body
        .as_object()
        .map(|o| {
            o.keys()
                .filter(|k| !known.contains(&k.as_str()))
                .map(|k| format!("property {k} should not exist"))
                .collect()
        })
        .unwrap_or_default();
    if !unknown.is_empty() {
        return Err(HttpError::validation(unknown).into());
    }
    serde_json::from_value(body).map_err(|_| HttpError::nest(400, None).into())
}

/// `DeleteKanbanColumnQueryDto`: `move_to_column_id` tuỳ chọn, số nguyên ≥ 1 (decorator khai sau chạy trước: `Min` rồi `IsInt`).
fn move_to_column(q: &HashMap<String, String>) -> Result<Option<i32>, AppError> {
    let mut errs: Vec<String> = q
        .keys()
        .filter(|k| k.as_str() != "move_to_column_id")
        .map(|k| format!("property {k} should not exist"))
        .collect();
    errs.sort();
    let mut value = None;
    if let Some(raw) = q.get("move_to_column_id") {
        let t = raw.trim();
        // `Number(s)` của JS: chuỗi rỗng là 0, không phải số là NaN.
        let n = if t.is_empty() {
            Some(0.0)
        } else {
            t.parse::<f64>().ok().filter(|n| n.is_finite())
        };
        if n.is_none_or(|n| n < 1.0) {
            errs.push("move_to_column_id không hợp lệ".to_owned());
        }
        if n.is_none_or(|n| n.fract() != 0.0) {
            errs.push("move_to_column_id phải là số nguyên".to_owned());
        }
        value = n;
    }
    if !errs.is_empty() {
        return Err(HttpError::validation(errs).into());
    }
    match value {
        None => Ok(None),
        Some(n) if n <= f64::from(i32::MAX) => Ok(Some(n as i32)),
        Some(_) => Err(HttpError::nest(400, None).into()),
    }
}

const BOARD_KEYS: &[&str] = &[
    "name",
    "description",
    "icon",
    "color",
    "visibility_role_ids",
    "card_prefix",
    "settings",
];
const UPDATE_BOARD_KEYS: &[&str] = &[
    "name",
    "description",
    "icon",
    "color",
    "visibility_role_ids",
    "card_prefix",
    "settings",
    "is_active",
];

// ───────────────────────────── bảng ─────────────────────────────

async fn list_boards(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    let res = async {
        let company = company_of(&u)?;
        let access = access_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        boards::find_all_visible(&mut cn, &access).await
    }
    .await;
    ok(res)
}

async fn create_board(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: CreateBoard = strict(body, BOARD_KEYS)?;
        input.validate()?;
        let company = company_of(&u)?;
        let mut cn = conn(&c, company).await?;
        boards::create(&mut cn, &input, u.user.user_id).await
    }
    .await;
    ok(res)
}

async fn board_templates() -> Response {
    Json(boards::list_templates()).into_response()
}

async fn board_from_template(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: CreateBoardFromTemplate = strict(body, &["template_key", "name"])?;
        input.validate()?;
        let company = company_of(&u)?;
        let mut cn = conn(&c, company).await?;
        boards::create_from_template(&mut cn, &input, u.user.user_id).await
    }
    .await;
    ok(res)
}

async fn get_board(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let res = async {
        let id = id_of(&id, "board")?;
        let company = company_of(&u)?;
        let access = access_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        boards::find_one_detail(&mut cn, &access, id).await
    }
    .await;
    ok(res)
}

async fn update_board(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: UpdateBoard = strict(body, UPDATE_BOARD_KEYS)?;
        input.validate()?;
        let id = id_of(&id, "board")?;
        let company = company_of(&u)?;
        let mut cn = conn(&c, company).await?;
        boards::update(&mut cn, id, &input).await
    }
    .await;
    ok(res)
}

async fn delete_board(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let res = async {
        let id = id_of(&id, "board")?;
        let company = company_of(&u)?;
        let mut cn = conn(&c, company).await?;
        boards::remove(&mut cn, id).await
    }
    .await;
    ok(res)
}

// ───────────────────────────── nhãn ─────────────────────────────

async fn create_label(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: CreateLabel = strict(body, &["name", "color"])?;
        input.validate()?;
        let id = id_of(&id, "board")?;
        let company = company_of(&u)?;
        let access = access_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        labels::create(&mut cn, &access, id, &input).await
    }
    .await;
    ok(res)
}

async fn update_label(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path((id, label_id)): Path<(String, String)>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: UpdateLabel = strict(body, &["name", "color"])?;
        input.validate()?;
        let id = id_of(&id, "board")?;
        let company = company_of(&u)?;
        let access = access_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        labels::update(&mut cn, &access, id, &label_id, &input).await
    }
    .await;
    ok(res)
}

async fn delete_label(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path((id, label_id)): Path<(String, String)>,
) -> Response {
    let res = async {
        let id = id_of(&id, "board")?;
        let company = company_of(&u)?;
        let access = access_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        labels::remove(&mut cn, &access, id, &label_id).await
    }
    .await;
    ok(res)
}

// ───────────────────────────── cột ─────────────────────────────

async fn create_column(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(board_id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: CreateColumn = strict(body, &["name", "color", "wip_limit", "is_done"])?;
        input.validate()?;
        let board_id = id_of(&board_id, "board")?;
        let mut cn = conn(&c, company_of(&u)?).await?;
        columns::create(&mut cn, board_id, &input).await
    }
    .await;
    ok(res)
}

async fn reorder_columns(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(board_id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: ReorderColumns = strict(body, &["column_ids"])?;
        input.validate()?;
        let board_id = id_of(&board_id, "board")?;
        let mut cn = conn(&c, company_of(&u)?).await?;
        columns::reorder(&mut cn, board_id, &input).await
    }
    .await;
    ok(res)
}

async fn update_column(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: UpdateColumn = strict(body, &["name", "color", "wip_limit", "is_done", "is_archived"])?;
        input.validate()?;
        let id = id_of(&id, "cột")?;
        let mut cn = conn(&c, company_of(&u)?).await?;
        columns::update(&mut cn, id, &input).await
    }
    .await;
    ok(res)
}

async fn delete_column(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let res = async {
        let move_to = move_to_column(&q)?;
        let id = id_of(&id, "cột")?;
        let mut cn = conn(&c, company_of(&u)?).await?;
        columns::remove(&mut cn, id, move_to, u.user.user_id).await
    }
    .await;
    ok(res)
}

// ───────────────────────────── trường tuỳ biến ─────────────────────────────

async fn create_field_def(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(board_id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: CreateFieldDef = strict(body, &["key", "label", "type", "options", "required", "show_on_card"])?;
        input.validate()?;
        let board_id = id_of(&board_id, "board")?;
        let mut cn = conn(&c, company_of(&u)?).await?;
        field_defs::create(&mut cn, board_id, &input).await
    }
    .await;
    ok(res)
}

async fn reorder_field_defs(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(board_id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: ReorderFieldDefs = strict(body, &["field_def_ids"])?;
        input.validate()?;
        let board_id = id_of(&board_id, "board")?;
        let mut cn = conn(&c, company_of(&u)?).await?;
        field_defs::reorder(&mut cn, board_id, &input).await
    }
    .await;
    ok(res)
}

async fn update_field_def(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: UpdateFieldDef = strict(body, &["label", "options", "required", "show_on_card"])?;
        input.validate()?;
        let id = id_of(&id, "trường")?;
        let mut cn = conn(&c, company_of(&u)?).await?;
        field_defs::update(&mut cn, id, &input).await
    }
    .await;
    ok(res)
}

async fn delete_field_def(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let res = async {
        let id = id_of(&id, "trường")?;
        let mut cn = conn(&c, company_of(&u)?).await?;
        field_defs::remove(&mut cn, id).await
    }
    .await;
    ok(res)
}

// ───────────────────────────── thẻ ─────────────────────────────

async fn list_cards(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    ValidQuery(QueryKanbanCardsDto(q)): ValidQuery<QueryKanbanCardsDto>,
) -> Response {
    let res = async {
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        cards::list(&mut cn, &actor, &q).await
    }
    .await;
    ok(res)
}

async fn create_card(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    ValidJson(CreateKanbanCardDto(input)): ValidJson<CreateKanbanCardDto>,
) -> Response {
    let res = async {
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        cards::create(&mut cn, &actor, &input).await
    }
    .await;
    ok(res)
}

async fn get_card(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, Path(id): Path<String>) -> Response {
    let res = async {
        let id = id_of(&id, "card")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        cards::find_one(&mut cn, &actor, id).await
    }
    .await;
    ok(res)
}

async fn update_card(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: UpdateCard = strict(
            body,
            &[
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
            ],
        )?;
        let id = id_of(&id, "card")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        cards::update(&mut cn, &actor, id, &input).await
    }
    .await;
    ok(res)
}

async fn delete_card(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let res = async {
        let id = id_of(&id, "card")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        cards::remove(&mut cn, &actor, id).await
    }
    .await;
    ok(res)
}

async fn move_card(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: MoveCard = strict(body, &["column_id", "before_card_id", "after_card_id"])?;
        let id = id_of(&id, "card")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        cards::move_card(&mut cn, &actor, id, &input).await
    }
    .await;
    ok(res)
}

async fn restore_card(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let res = async {
        let id = id_of(&id, "card")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        cards::restore(&mut cn, &actor, id).await
    }
    .await;
    ok(res)
}

async fn list_activities(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let res = async {
        let id = id_of(&id, "card")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        activities::list(&mut cn, &actor, id).await
    }
    .await;
    ok(res)
}

async fn add_comment(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: CreateComment = strict(body, &["content"])?;
        input.validate()?;
        let id = id_of(&id, "card")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        activities::add_comment(&mut cn, &actor, id, &input).await
    }
    .await;
    ok(res)
}

// ───────────────────────────── checklist ─────────────────────────────

async fn list_items(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(card_id): Path<String>,
) -> Response {
    let res = async {
        let card_id = id_of(&card_id, "card")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        checklist::list(&mut cn, &actor, card_id).await
    }
    .await;
    ok(res)
}

async fn create_item(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(card_id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: CreateItem = strict(body, &["text"])?;
        input.validate()?;
        let card_id = id_of(&card_id, "card")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        checklist::create(&mut cn, &actor, card_id, &input).await
    }
    .await;
    ok(res)
}

async fn reorder_items(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(card_id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: ReorderItems = strict(body, &["item_ids"])?;
        input.validate()?;
        let card_id = id_of(&card_id, "card")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        checklist::reorder(&mut cn, &actor, card_id, &input).await
    }
    .await;
    ok(res)
}

async fn update_item(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: UpdateItem = strict(body, &["text", "is_done"])?;
        input.validate()?;
        let id = id_of(&id, "mục checklist")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        checklist::update(&mut cn, &actor, id, &input).await
    }
    .await;
    ok(res)
}

async fn delete_item(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let res = async {
        let id = id_of(&id, "mục checklist")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        checklist::remove(&mut cn, &actor, id).await
    }
    .await;
    ok(res)
}

// ───────────────────────────── đính kèm (liên kết) ─────────────────────────────

async fn list_attachments(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(card_id): Path<String>,
) -> Response {
    let res = async {
        let card_id = id_of(&card_id, "card")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        attachments::list(&mut cn, &actor, card_id).await
    }
    .await;
    ok(res)
}

async fn create_attachment(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(card_id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let res = async {
        let input: CreateAttachment = strict(body, &["url", "title"])?;
        input.validate()?;
        let card_id = id_of(&card_id, "card")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        attachments::create(&mut cn, &actor, card_id, &input).await
    }
    .await;
    ok(res)
}

async fn delete_attachment(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Response {
    let res = async {
        let id = id_of(&id, "tệp đính kèm")?;
        let company = company_of(&u)?;
        let actor = actor_of(&c, company, &u).await?;
        let mut cn = conn(&c, company).await?;
        attachments::remove(&mut cn, &actor, id).await
    }
    .await;
    ok(res)
}

/// Router của module: mọi route đi qua `ApiRouter` (khai quyền bắt buộc). Người gọi gắn state `Arc<Ctx>` khi lắp `serve`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let mut table = routes::board_routes();
    table.extend(routes::routes());
    // `suffix` là phần sau `/api/v1/kanban`.
    let sp = |m: Method, suffix: &str| -> RouteSpec {
        let path = format!("/api/v1/kanban{suffix}");
        table
            .iter()
            .find(|x| x.method == m && x.path == path)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {path}"))
    };
    ApiRouter::new(deps)
        .route(sp(Method::GET, "/boards"), list_boards)
        .route(sp(Method::POST, "/boards"), create_board)
        .route(sp(Method::GET, "/boards/templates"), board_templates)
        .route(sp(Method::POST, "/boards/from-template"), board_from_template)
        .route(sp(Method::GET, "/boards/:id"), get_board)
        .route(sp(Method::PATCH, "/boards/:id"), update_board)
        .route(sp(Method::DELETE, "/boards/:id"), delete_board)
        .route(sp(Method::POST, "/boards/:id/labels"), create_label)
        .route(sp(Method::PATCH, "/boards/:id/labels/:labelId"), update_label)
        .route(sp(Method::DELETE, "/boards/:id/labels/:labelId"), delete_label)
        .route(sp(Method::POST, "/boards/:boardId/columns"), create_column)
        .route(sp(Method::POST, "/boards/:boardId/columns/reorder"), reorder_columns)
        .route(sp(Method::PATCH, "/columns/:id"), update_column)
        .route(sp(Method::DELETE, "/columns/:id"), delete_column)
        .route(sp(Method::POST, "/boards/:boardId/field-defs"), create_field_def)
        .route(
            sp(Method::POST, "/boards/:boardId/field-defs/reorder"),
            reorder_field_defs,
        )
        .route(sp(Method::PATCH, "/field-defs/:id"), update_field_def)
        .route(sp(Method::DELETE, "/field-defs/:id"), delete_field_def)
        .route(sp(Method::GET, "/cards"), list_cards)
        .route(sp(Method::POST, "/cards"), create_card)
        .route(sp(Method::GET, "/cards/:id"), get_card)
        .route(sp(Method::PATCH, "/cards/:id"), update_card)
        .route(sp(Method::DELETE, "/cards/:id"), delete_card)
        .route(sp(Method::POST, "/cards/:id/move"), move_card)
        .route(sp(Method::POST, "/cards/:id/restore"), restore_card)
        .route(sp(Method::GET, "/cards/:id/activities"), list_activities)
        .route(sp(Method::POST, "/cards/:id/comments"), add_comment)
        .route(sp(Method::GET, "/cards/:cardId/checklist-items"), list_items)
        .route(sp(Method::POST, "/cards/:cardId/checklist-items"), create_item)
        .route(
            sp(Method::POST, "/cards/:cardId/checklist-items/reorder"),
            reorder_items,
        )
        .route(sp(Method::PATCH, "/checklist-items/:id"), update_item)
        .route(sp(Method::DELETE, "/checklist-items/:id"), delete_item)
        .route(sp(Method::GET, "/cards/:cardId/attachments"), list_attachments)
        .route(sp(Method::POST, "/cards/:cardId/attachments"), create_attachment)
        .route(sp(Method::DELETE, "/attachments/:id"), delete_attachment)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn move_to_column_theo_dto() {
        let q = |v: &[(&str, &str)]| v.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        assert_eq!(move_to_column(&q(&[])).unwrap(), None);
        assert_eq!(move_to_column(&q(&[("move_to_column_id", "7")])).unwrap(), Some(7));
        assert!(move_to_column(&q(&[("move_to_column_id", "0")])).is_err());
        assert!(move_to_column(&q(&[("move_to_column_id", "1.5")])).is_err());
        assert!(move_to_column(&q(&[("move_to_column_id", "abc")])).is_err());
        assert!(move_to_column(&q(&[("x", "1")])).is_err());
    }

    #[test]
    fn strict_chan_khoa_la() {
        let r: Result<CreateComment, AppError> = strict(json!({"content": "a", "x": 1}), &["content"]);
        assert!(r.is_err());
        let r: Result<CreateComment, AppError> = strict(json!({"content": "a"}), &["content"]);
        assert!(r.is_ok());
    }

    #[test]
    fn router_dung_du_35_route() {
        let n = routes::board_routes().len() + routes::routes().len();
        assert_eq!(n, 35);
    }
}
