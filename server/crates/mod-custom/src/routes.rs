//! Bảng route và handler (K14): 15 route cấu trúc `/api/v1/custom-objects` (M17), 8 route bản ghi cùng `/custom-objects/:key/...` và
//! 4 route `/api/v1/refs/*` (M18). Quyền, mã thành công và chế độ kiểm dữ liệu (strict) khớp `contracts/routes.json`; hai route
//! mẫu bảng (`templates`, `templates/:template/apply`) thuộc M19.

use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{Extension, FromRequest, Path, Request, State};
use axum::http::{Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::extract::{parse_int_param, query_to_json};
use trinity_http::validate::{Mode, validate_value};
use trinity_kernel::error::{AppError, HttpError};

use crate::fields::{CreateField, UpdateField};
use crate::lookups::LookupQuery;
use crate::objects::{CreateObject, UpdateObject};
use crate::{Actor, Ctx, export, fields, lookups, objects, present, records, refs, views};

const BASE: &str = "/api/v1/custom-objects";
const MANAGE: Access = Access::Can(&["custom_objects.manage"]);
const VIEW: Access = Access::Can(&["custom_records.view"]);
const VIEW_OR_MANAGE: Access = Access::CanAny(&["custom_records.view", "custom_objects.manage"]);
const LOOKUP: Access = Access::CanAny(&["custom_records.view", "custom_records.manage"]);
const REC_WRITE: Access = Access::Can(&["custom_records.view", "custom_records.manage"]);
const REC_DELETE: Access = Access::Can(&["custom_records.view", "custom_records.delete"]);
const REC_EXPORT: Access = Access::Can(&["custom_records.view", "custom_records.export"]);
const REFS_READ: Access = Access::CanAny(&["custom_records.view", "contacts.view", "deals.view", "kanban.view"]);
const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 27 dòng của bảng route, so với `routes.json` bởi `trinity check-routes`.
pub fn specs() -> Vec<RouteSpec> {
    let s = |m: Method, p: &'static str, a: Access, ok: u16| RouteSpec::new(m, p, a).status_ok(ok);
    vec![
        s(Method::GET, BASE, MANAGE, 200),
        s(Method::POST, BASE, MANAGE, 201),
        s(Method::GET, "/api/v1/custom-objects/nav", VIEW, 200),
        s(Method::GET, "/api/v1/custom-objects/lookup/users", LOOKUP, 200),
        s(Method::GET, "/api/v1/custom-objects/lookup/contacts", LOOKUP, 200),
        s(Method::POST, "/api/v1/custom-objects/formula/preview", MANAGE, 201),
        s(Method::GET, "/api/v1/custom-objects/:key", VIEW_OR_MANAGE, 200),
        s(Method::GET, "/api/v1/custom-objects/:key/views", VIEW, 200),
        s(Method::GET, "/api/v1/custom-objects/:key/views/:view", VIEW, 200),
        s(Method::PATCH, "/api/v1/custom-objects/:key", MANAGE, 200),
        s(Method::DELETE, "/api/v1/custom-objects/:key", MANAGE, 200),
        s(Method::POST, "/api/v1/custom-objects/:key/fields", MANAGE, 201),
        s(Method::PUT, "/api/v1/custom-objects/:key/fields/order", MANAGE, 200),
        s(
            Method::PATCH,
            "/api/v1/custom-objects/:key/fields/:fieldKey",
            MANAGE,
            200,
        ),
        s(
            Method::DELETE,
            "/api/v1/custom-objects/:key/fields/:fieldKey",
            MANAGE,
            200,
        ),
        s(Method::GET, "/api/v1/custom-objects/:key/lookup", VIEW, 200),
        s(Method::GET, "/api/v1/custom-objects/:key/records", VIEW, 200),
        s(Method::POST, "/api/v1/custom-objects/:key/records", REC_WRITE, 201),
        s(
            Method::GET,
            "/api/v1/custom-objects/:key/records/export",
            REC_EXPORT,
            200,
        ),
        s(Method::GET, "/api/v1/custom-objects/:key/records/:id", VIEW, 200).param_pipes(ID),
        s(
            Method::GET,
            "/api/v1/custom-objects/:key/records/:id/related",
            VIEW,
            200,
        )
        .param_pipes(ID),
        s(Method::PATCH, "/api/v1/custom-objects/:key/records/:id", REC_WRITE, 200).param_pipes(ID),
        s(
            Method::DELETE,
            "/api/v1/custom-objects/:key/records/:id",
            REC_DELETE,
            200,
        )
        .param_pipes(ID),
        s(Method::GET, "/api/v1/refs/suggest", REFS_READ, 200),
        s(Method::GET, "/api/v1/refs/resolve", REFS_READ, 200),
        s(Method::GET, "/api/v1/refs/:type/:id/backlinks", REFS_READ, 200).param_pipes(ID),
        s(Method::GET, "/api/v1/refs/:type/:id/preview", REFS_READ, 200).param_pipes(ID),
    ]
}

fn fail(e: impl Into<AppError>) -> Response {
    let (status, body) = e.into().response(true);
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}

fn ok(r: Result<Value, AppError>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => fail(e),
    }
}

/// Công ty trong token không hợp lệ ⇒ 401 như guard (không đoán công ty 1).
fn actor(u: &CurrentUser) -> Result<Actor, Response> {
    match trinity_db::CompanyRef::new(i64::from(u.user.company_id)) {
        Ok(company) => Ok(Actor {
            user_id: u.user.user_id,
            company,
            grants: u.grants.grants.clone(),
            is_admin: u.grants.is_admin,
        }),
        Err(_) => Err(fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn"))),
    }
}

macro_rules! ac {
    ($u:expr) => {
        match actor(&$u) {
            Ok(a) => a,
            Err(r) => return r,
        }
    };
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

fn dto(name: &str, body: &Value) -> Result<Value, AppError> {
    validate_value(name, body, Mode::Strict)
}

async fn list(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(objects::list(&c, &ac!(u)).await)
}

async fn create(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, JsonBody(b): JsonBody) -> Response {
    match dto("CreateCustomObjectDto", &b) {
        Ok(v) => ok(objects::create(&c, &ac!(u), &CreateObject::from_validated(&v)).await),
        Err(e) => fail(e),
    }
}

async fn nav(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>) -> Response {
    ok(objects::nav(&c, &ac!(u)).await)
}

async fn lookup_users(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, uri: Uri) -> Response {
    match dto("LookupQueryDto", &query_to_json(uri.query().unwrap_or(""))) {
        Ok(v) => ok(lookups::lookup_users(&c, &ac!(u), &LookupQuery::from_validated(&v)).await),
        Err(e) => fail(e),
    }
}

async fn lookup_contacts(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, uri: Uri) -> Response {
    match dto("LookupQueryDto", &query_to_json(uri.query().unwrap_or(""))) {
        Ok(v) => ok(lookups::lookup_contacts(&c, &ac!(u), &LookupQuery::from_validated(&v)).await),
        Err(e) => fail(e),
    }
}

async fn preview(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, JsonBody(b): JsonBody) -> Response {
    match dto("FormulaPreviewDto", &b) {
        Ok(v) => ok(fields::preview_formula(&c, &ac!(u), &v).await),
        Err(e) => fail(e),
    }
}

async fn get_one(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, Path(key): Path<String>) -> Response {
    ok(objects::get_definition(&c, &ac!(u), &key).await)
}

async fn list_views(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(key): Path<String>,
) -> Response {
    ok(views::list(&c, &ac!(u), &key).await)
}

async fn get_view(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path((key, view)): Path<(String, String)>,
) -> Response {
    ok(views::get(&c, &ac!(u), &key, &view).await)
}

async fn update(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(key): Path<String>,
    JsonBody(b): JsonBody,
) -> Response {
    match dto("UpdateCustomObjectDto", &b) {
        Ok(v) => ok(objects::update(&c, &ac!(u), &key, &UpdateObject::from_validated(&v)).await),
        Err(e) => fail(e),
    }
}

async fn remove(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, Path(key): Path<String>) -> Response {
    ok(objects::remove(&c, &ac!(u), &key).await)
}

async fn add_field(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(key): Path<String>,
    JsonBody(b): JsonBody,
) -> Response {
    match dto("CreateCustomFieldDto", &b) {
        Ok(v) => ok(fields::create(&c, &ac!(u), &key, &CreateField::from_validated(&v)).await),
        Err(e) => fail(e),
    }
}

async fn reorder(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(key): Path<String>,
    JsonBody(b): JsonBody,
) -> Response {
    match dto("ReorderCustomFieldsDto", &b) {
        Ok(v) => {
            let keys: Vec<String> = v
                .get("keys")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|k| k.as_str().map(str::to_owned)).collect())
                .unwrap_or_default();
            ok(fields::reorder(&c, &ac!(u), &key, &keys).await)
        }
        Err(e) => fail(e),
    }
}

async fn update_field(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path((key, field)): Path<(String, String)>,
    JsonBody(b): JsonBody,
) -> Response {
    match dto("UpdateCustomFieldDto", &b) {
        Ok(v) => ok(fields::update(&c, &ac!(u), &key, &field, &UpdateField::from_validated(&v)).await),
        Err(e) => fail(e),
    }
}

async fn remove_field(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path((key, field)): Path<(String, String)>,
) -> Response {
    ok(fields::remove(&c, &ac!(u), &key, &field).await)
}

fn id_param(raw: &str) -> Result<i64, Response> {
    parse_int_param(raw).map_err(fail)
}

fn query(uri: &Uri) -> Value {
    query_to_json(uri.query().unwrap_or(""))
}

async fn rec_list(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(key): Path<String>,
    uri: Uri,
) -> Response {
    match dto("ListCustomRecordsQueryDto", &query(&uri)) {
        Ok(q) => ok(records::list(&c, &ac!(u), &key, &q).await),
        Err(e) => fail(e),
    }
}

async fn rec_lookup(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(key): Path<String>,
    uri: Uri,
) -> Response {
    match dto("LookupQueryDto", &query(&uri)) {
        Ok(q) => ok(records::lookup(&c, &ac!(u), &key, &q).await),
        Err(e) => fail(e),
    }
}

async fn rec_create(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(key): Path<String>,
    JsonBody(b): JsonBody,
) -> Response {
    match dto("CustomRecordBodyDto", &b) {
        Ok(v) => ok(records::create(&c, &ac!(u), &key, &v).await),
        Err(e) => fail(e),
    }
}

async fn rec_get(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path((key, id)): Path<(String, String)>,
) -> Response {
    match id_param(&id) {
        Ok(id) => ok(records::get_one(&c, &ac!(u), &key, id).await),
        Err(r) => r,
    }
}

async fn rec_related(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path((key, id)): Path<(String, String)>,
) -> Response {
    match id_param(&id) {
        Ok(id) => ok(records::related(&c, &ac!(u), &key, id).await),
        Err(r) => r,
    }
}

async fn rec_update(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path((key, id)): Path<(String, String)>,
    JsonBody(b): JsonBody,
) -> Response {
    let id = match id_param(&id) {
        Ok(id) => id,
        Err(r) => return r,
    };
    match dto("CustomRecordBodyDto", &b) {
        Ok(v) => ok(records::update(&c, &ac!(u), &key, id, &v).await),
        Err(e) => fail(e),
    }
}

async fn rec_remove(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path((key, id)): Path<(String, String)>,
) -> Response {
    match id_param(&id) {
        Ok(id) => ok(records::remove(&c, &ac!(u), &key, id).await),
        Err(r) => r,
    }
}

/// Đuôi `filename*` như `encodeURIComponent`.
fn encode_component(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                char::from(b).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn rec_export(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path(key): Path<String>,
    uri: Uri,
) -> Response {
    let q = match dto("ListCustomRecordsQueryDto", &query(&uri)) {
        Ok(q) => q,
        Err(e) => return fail(e),
    };
    let actor = ac!(u);
    let run = async {
        let scopes = export::ExportScopes::load(&c, &actor).await?;
        let mut conn = c.conn(actor.company).await?;
        export::collect(&actor, &mut conn, &scopes, &key, &q).await
    };
    match run.await {
        Ok((def, out)) => {
            let name = export::filename(&def, "csv");
            let headers = [
                (header::CONTENT_TYPE.as_str(), "text/csv; charset=utf-8".to_owned()),
                (
                    header::CONTENT_DISPOSITION.as_str(),
                    format!(
                        "attachment; filename=\"{name}\"; filename*=UTF-8''{}",
                        encode_component(&name)
                    ),
                ),
                (header::CACHE_CONTROL.as_str(), "private, no-store".to_owned()),
                ("x-total-rows", out.total.to_string()),
                ("x-exported-rows", out.exported.to_string()),
                ("x-truncated", out.truncated.to_string()),
                (
                    "access-control-expose-headers",
                    "X-Total-Rows, X-Exported-Rows, X-Truncated, Content-Disposition".to_owned(),
                ),
            ];
            (StatusCode::OK, headers, out.csv()).into_response()
        }
        Err(e) => fail(e),
    }
}

/// Nạp quyền tham chiếu rồi chạy `f` với kết nối (không xin kết nối thứ hai khi đang giữ một).
macro_rules! with_refs {
    ($c:expr, $actor:expr, |$conn:ident, $acc:ident| $body:expr) => {{
        let run = async {
            let owners = refs::Owners::load(&$c, &$actor).await?;
            let mut $conn = $c.conn($actor.company).await?;
            let $acc = refs::RefAccess::build(&mut $conn, &$actor, owners).await?;
            $body
        };
        ok(run.await)
    }};
}

async fn refs_suggest(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, uri: Uri) -> Response {
    let q = match dto("RefSuggestQueryDto", &query(&uri)) {
        Ok(q) => q,
        Err(e) => return fail(e),
    };
    let actor = ac!(u);
    let text = q.get("q").and_then(Value::as_str).unwrap_or("").to_owned();
    let limit = q.get("limit").and_then(Value::as_i64).unwrap_or(8);
    with_refs!(c, actor, |conn, acc| {
        let found = refs::suggest(&mut conn, &acc, &text, limit).await?;
        Ok(Value::Array(found.iter().map(refs::RefView::to_json).collect()))
    })
}

async fn refs_resolve(State(c): State<Arc<Ctx>>, Extension(u): Extension<CurrentUser>, uri: Uri) -> Response {
    let q = match dto("RefResolveQueryDto", &query(&uri)) {
        Ok(q) => q,
        Err(e) => return fail(e),
    };
    let actor = ac!(u);
    let codes: Vec<String> = q
        .get("codes")
        .and_then(Value::as_str)
        .unwrap_or("")
        .split(',')
        .map(|c| trinity_kernel::vi::trim_js(c).to_owned())
        .filter(|c| !c.is_empty())
        .take(50)
        .collect();
    with_refs!(c, actor, |conn, acc| {
        let map = refs::resolve_codes(&mut conn, &acc, &codes).await?;
        let mut found: Vec<(String, refs::RefView)> = map.into_iter().collect();
        // Thứ tự theo mã người gọi nhập (Node trả theo thứ tự chèn của Map).
        found.sort_by_key(|(code, _)| {
            codes
                .iter()
                .position(|c| refs::parse_code(c).is_some_and(|p| p.code == *code))
        });
        Ok(Value::Array(
            found
                .into_iter()
                .map(|(code, v)| {
                    let mut j = v.to_json();
                    if let Some(o) = j.as_object_mut() {
                        o.insert("requested".into(), Value::String(code));
                    }
                    j
                })
                .collect(),
        ))
    })
}

fn ref_target(ty: &str, id: &str) -> Result<refs::Ref, Response> {
    let id = id_param(id)?;
    let ty = refs::RefType::parse(ty).ok_or_else(|| fail(HttpError::bad_request("Loại bản ghi không hợp lệ")))?;
    let id = i32::try_from(id).map_err(|_| fail(HttpError::not_found("Không tìm thấy bản ghi")))?;
    Ok(refs::Ref { ty, id })
}

async fn refs_backlinks(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path((ty, id)): Path<(String, String)>,
) -> Response {
    let target = match ref_target(&ty, &id) {
        Ok(t) => t,
        Err(r) => return r,
    };
    let actor = ac!(u);
    with_refs!(c, actor, |conn, acc| refs::backlinks(&mut conn, &acc, target).await)
}

async fn refs_preview(
    State(c): State<Arc<Ctx>>,
    Extension(u): Extension<CurrentUser>,
    Path((ty, id)): Path<(String, String)>,
) -> Response {
    let target = match ref_target(&ty, &id) {
        Ok(t) => t,
        Err(r) => return r,
    };
    let actor = ac!(u);
    let run = async {
        let env = present::Env::load(&c, &actor).await?;
        let mut conn = c.conn(actor.company).await?;
        let acc = refs::RefAccess::build(&mut conn, &actor, env.owners.clone()).await?;
        refs::preview(&actor, &mut conn, &acc, &env, target).await
    };
    ok(run.await)
}

/// Router của module (người gọi gắn state `Arc<Ctx>` khi lắp `serve`).
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    ApiRouter::new(deps)
        .route(spec(&Method::GET, BASE), list)
        .route(spec(&Method::POST, BASE), create)
        .route(spec(&Method::GET, "/api/v1/custom-objects/nav"), nav)
        .route(spec(&Method::GET, "/api/v1/custom-objects/lookup/users"), lookup_users)
        .route(
            spec(&Method::GET, "/api/v1/custom-objects/lookup/contacts"),
            lookup_contacts,
        )
        .route(spec(&Method::POST, "/api/v1/custom-objects/formula/preview"), preview)
        .route(spec(&Method::GET, "/api/v1/custom-objects/:key"), get_one)
        .route(spec(&Method::GET, "/api/v1/custom-objects/:key/views"), list_views)
        .route(spec(&Method::GET, "/api/v1/custom-objects/:key/views/:view"), get_view)
        .route(spec(&Method::PATCH, "/api/v1/custom-objects/:key"), update)
        .route(spec(&Method::DELETE, "/api/v1/custom-objects/:key"), remove)
        .route(spec(&Method::POST, "/api/v1/custom-objects/:key/fields"), add_field)
        .route(spec(&Method::PUT, "/api/v1/custom-objects/:key/fields/order"), reorder)
        .route(
            spec(&Method::PATCH, "/api/v1/custom-objects/:key/fields/:fieldKey"),
            update_field,
        )
        .route(
            spec(&Method::DELETE, "/api/v1/custom-objects/:key/fields/:fieldKey"),
            remove_field,
        )
        .route(spec(&Method::GET, "/api/v1/custom-objects/:key/lookup"), rec_lookup)
        .route(spec(&Method::GET, "/api/v1/custom-objects/:key/records"), rec_list)
        .route(spec(&Method::POST, "/api/v1/custom-objects/:key/records"), rec_create)
        .route(
            spec(&Method::GET, "/api/v1/custom-objects/:key/records/export"),
            rec_export,
        )
        .route(spec(&Method::GET, "/api/v1/custom-objects/:key/records/:id"), rec_get)
        .route(
            spec(&Method::GET, "/api/v1/custom-objects/:key/records/:id/related"),
            rec_related,
        )
        .route(
            spec(&Method::PATCH, "/api/v1/custom-objects/:key/records/:id"),
            rec_update,
        )
        .route(
            spec(&Method::DELETE, "/api/v1/custom-objects/:key/records/:id"),
            rec_remove,
        )
        .route(spec(&Method::GET, "/api/v1/refs/suggest"), refs_suggest)
        .route(spec(&Method::GET, "/api/v1/refs/resolve"), refs_resolve)
        .route(spec(&Method::GET, "/api/v1/refs/:type/:id/backlinks"), refs_backlinks)
        .route(spec(&Method::GET, "/api/v1/refs/:type/:id/preview"), refs_preview)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = specs();
        assert_eq!(table.len(), 27);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 27);
    }

    #[test]
    fn ma_hoa_ten_tep() {
        assert_eq!(encode_component("m18_hs-20261127.csv"), "m18_hs-20261127.csv");
        assert_eq!(encode_component("a b/é"), "a%20b%2F%C3%A9");
    }
}
