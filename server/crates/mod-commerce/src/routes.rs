//! Bảng route và handler của commerce (K14): sản phẩm, danh mục, thuộc tính động, ảnh sản phẩm, dự án. Quyền và mã thành công
//! khớp `contracts/routes.json`; GET đòi `products.view`, ghi đòi `products.manage`.

#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Bytes, to_bytes};
use axum::extract::{DefaultBodyLimit, Extension, FromRequest, Multipart, Path, Query, Request, State};
use axum::handler::Handler;
use axum::response::{IntoResponse, Response};
use http::{Method, StatusCode, header};
use serde::Serialize;
use serde_json::{Map, Value, json};
use trinity_db::{CompanyRef, Db};
use trinity_http::edge::body::read_field_limited;
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_http::validate::{ValidJson, ValidQuery};
use trinity_kernel::error::{AppError, HttpError};
use trinity_storage::LocalUploadsStore;

use crate::image::{PRODUCT_IMAGE_MAX_BYTES, save_product_image};
use crate::products::{CreateProduct, ListProducts};
use crate::{Actor, attribute_defs, categories, dto, products, projects};

const ID: &[&str] = &["param.id:ParseInt4Pipe"];
const CATEGORY_ID: &[&str] = &["param.categoryId:ParseInt4Pipe"];
const VIEW: Access = Access::Can(&["products.view"]);
const MANAGE: Access = Access::Can(&["products.manage"]);

/// Bảng route của module (21 dòng), so với `routes.json` bởi `trinity check-routes`.
pub fn specs() -> Vec<RouteSpec> {
    let r = |m: Method, p: &'static str, a: Access, ok: u16| RouteSpec::new(m, p, a).status_ok(ok);
    vec![
        r(Method::GET, "/api/v1/products", VIEW, 200),
        r(Method::POST, "/api/v1/products", MANAGE, 201),
        r(Method::POST, "/api/v1/products/upload-image", MANAGE, 201),
        r(Method::GET, "/api/v1/products/:id", VIEW, 200).param_pipes(ID),
        r(Method::PATCH, "/api/v1/products/:id", MANAGE, 200).param_pipes(ID),
        r(Method::DELETE, "/api/v1/products/:id", MANAGE, 200).param_pipes(ID),
        r(Method::POST, "/api/v1/products/:id/restore", MANAGE, 201).param_pipes(ID),
        r(Method::DELETE, "/api/v1/products/:id/permanent", MANAGE, 200).param_pipes(ID),
        r(Method::GET, "/api/v1/product-categories", VIEW, 200),
        r(Method::POST, "/api/v1/product-categories", MANAGE, 201),
        r(Method::GET, "/api/v1/product-categories/:id", VIEW, 200).param_pipes(ID),
        r(Method::PATCH, "/api/v1/product-categories/:id", MANAGE, 200).param_pipes(ID),
        r(
            Method::GET,
            "/api/v1/product-categories/:categoryId/attribute-defs",
            VIEW,
            200,
        )
        .param_pipes(CATEGORY_ID),
        r(
            Method::POST,
            "/api/v1/product-categories/:categoryId/attribute-defs",
            MANAGE,
            201,
        )
        .param_pipes(CATEGORY_ID),
        r(Method::PATCH, "/api/v1/product-attribute-defs/:id", MANAGE, 200).param_pipes(ID),
        r(Method::DELETE, "/api/v1/product-attribute-defs/:id", MANAGE, 204).param_pipes(ID),
        r(Method::GET, "/api/v1/projects", VIEW, 200),
        r(Method::POST, "/api/v1/projects", MANAGE, 201),
        r(Method::GET, "/api/v1/projects/:id", VIEW, 200).param_pipes(ID),
        r(Method::PATCH, "/api/v1/projects/:id", MANAGE, 200).param_pipes(ID),
        r(Method::DELETE, "/api/v1/projects/:id", MANAGE, 200).param_pipes(ID),
    ]
}

/// Phụ thuộc của module: dựng một lần ở `serve`.
pub struct Ctx {
    pub db: Db,
    pub uploads: LocalUploadsStore,
}

impl Ctx {
    async fn conn(&self, company: CompanyRef) -> Result<trinity_db::TenantConn, AppError> {
        self.db
            .tenant(company)
            .await
            .map_err(AppError::internal)?
            .acquire()
            .await
            .map_err(AppError::internal)
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
        Ok(v) => Json(v).into_response(),
        Err(e) => fail(e),
    }
}

/// Công ty của token không hợp lệ ⇒ 401 (đóng, không rơi về công ty mặc định).
fn company_of(u: &CurrentUser) -> Result<CompanyRef, Response> {
    CompanyRef::new(i64::from(u.user.company_id))
        .map_err(|_| fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")))
}

macro_rules! company {
    ($u:expr) => {
        match company_of(&$u) {
            Ok(c) => c,
            Err(r) => return r,
        }
    };
}

fn actor(u: &CurrentUser) -> Actor {
    Actor {
        user_id: u.user.user_id,
        is_admin: u.grants.is_admin,
    }
}

/// `ParseInt4Pipe` đã chạy ở router: id trong 1..=INT4_MAX.
fn id_of(raw: &str) -> Result<i32, AppError> {
    raw.parse::<i32>()
        .map_err(|_| HttpError::bad_request("id vượt giới hạn số nguyên 32-bit").into())
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

type S = State<Arc<Ctx>>;
type U = Extension<CurrentUser>;

async fn product_list(State(c): S, Extension(u): U, ValidQuery(q): ValidQuery<ListProducts>) -> Response {
    let co = company!(u);
    let r = async {
        let mut conn = c.conn(co).await?;
        products::find_all(&mut conn, &q, actor(&u)).await
    }
    .await;
    ok(r)
}

async fn product_get(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let co = company!(u);
    let r = async {
        let id = id_of(&id)?;
        let mut conn = c.conn(co).await?;
        products::find_one(&mut conn, id).await
    }
    .await;
    ok(r)
}

async fn product_create(State(c): S, Extension(u): U, ValidJson(input): ValidJson<CreateProduct>) -> Response {
    let co = company!(u);
    let r = async {
        let mut conn = c.conn(co).await?;
        products::create(&mut conn, &input, u.user.user_id).await
    }
    .await;
    ok(r)
}

async fn product_update(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    let co = company!(u);
    let input = match dto::update_product(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let r = async {
        let id = id_of(&id)?;
        let mut conn = c.conn(co).await?;
        products::update(&mut conn, id, &input).await
    }
    .await;
    ok(r)
}

async fn product_remove(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let co = company!(u);
    let r = async {
        let id = id_of(&id)?;
        let mut conn = c.conn(co).await?;
        products::remove(&mut conn, id, actor(&u)).await
    }
    .await;
    ok(r)
}

async fn product_restore(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let co = company!(u);
    let r = async {
        let id = id_of(&id)?;
        let mut conn = c.conn(co).await?;
        products::restore(&mut conn, id, actor(&u)).await
    }
    .await;
    ok(r)
}

async fn product_purge(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let co = company!(u);
    let r = async {
        let id = id_of(&id)?;
        let tenant = c.db.tenant(co).await.map_err(AppError::internal)?;
        products::purge(&tenant, &c.uploads, id, actor(&u)).await
    }
    .await;
    ok(r)
}

/// Đọc multipart như `FileInterceptor('file')` của multer: trường tệp duy nhất tên `file`; loại không phải `image/*` ⇒ 400, vượt
/// 5MB ⇒ 413 `File too large`. Trả nội dung tệp (nếu có).
async fn read_image(mut mp: Multipart) -> Result<Option<Bytes>, AppError> {
    let mut file: Option<Bytes> = None;
    while let Some(mut f) = mp
        .next_field()
        .await
        .map_err(|_| HttpError::bad_request("Bad Request"))?
    {
        if f.file_name().is_none() {
            continue;
        }
        if f.name().unwrap_or("") != "file" || file.is_some() {
            return Err(HttpError::bad_request("Unexpected field").into());
        }
        let is_image = f
            .content_type()
            .is_some_and(|m| m.trim().to_ascii_lowercase().starts_with("image/"));
        if !is_image {
            return Err(HttpError::bad_request("File phải là ảnh (JPG, PNG, WebP, GIF)").into());
        }
        file = Some(read_field_limited(&mut f, PRODUCT_IMAGE_MAX_BYTES).await?);
    }
    Ok(file)
}

async fn product_upload(State(c): S, Extension(u): U, mp: Multipart) -> Response {
    let co = company!(u);
    let r = async {
        let file = read_image(mp).await?;
        let url = save_product_image(&c.uploads, co, file.as_deref()).await?;
        Ok::<_, AppError>(json!({ "image_url": url }))
    }
    .await;
    ok(r)
}

async fn category_list(State(c): S, Extension(u): U, Query(q): Query<HashMap<String, String>>) -> Response {
    let co = company!(u);
    let include_inactive = q.get("include_inactive").is_some_and(|v| v == "true");
    let r = async {
        let mut conn = c.conn(co).await?;
        categories::find_all(&mut conn, include_inactive).await
    }
    .await;
    ok(r)
}

async fn category_get(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let co = company!(u);
    let r = async {
        let id = id_of(&id)?;
        let mut conn = c.conn(co).await?;
        categories::find_one(&mut conn, id).await
    }
    .await;
    ok(r)
}

async fn category_create(State(c): S, Extension(u): U, JsonBody(body): JsonBody) -> Response {
    let co = company!(u);
    let input = match dto::create_category(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let r = async {
        let mut conn = c.conn(co).await?;
        categories::create(&mut conn, &input, u.user.user_id).await
    }
    .await;
    ok(r)
}

async fn category_update(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    let co = company!(u);
    let input = match dto::update_category(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let r = async {
        let id = id_of(&id)?;
        let mut conn = c.conn(co).await?;
        categories::update(&mut conn, id, &input).await
    }
    .await;
    ok(r)
}

async fn defs_list(State(c): S, Extension(u): U, Path(category_id): Path<String>) -> Response {
    let co = company!(u);
    let r = async {
        let id = id_of(&category_id)?;
        let mut conn = c.conn(co).await?;
        attribute_defs::find_all_for_category(&mut conn, id).await
    }
    .await;
    ok(r)
}

async fn defs_create(
    State(c): S,
    Extension(u): U,
    Path(category_id): Path<String>,
    JsonBody(body): JsonBody,
) -> Response {
    let co = company!(u);
    let input = match dto::create_attribute_def(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let r = async {
        let id = id_of(&category_id)?;
        let mut conn = c.conn(co).await?;
        attribute_defs::create(&mut conn, id, &input).await
    }
    .await;
    ok(r)
}

async fn def_update(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    let co = company!(u);
    let input = match dto::update_attribute_def(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let r = async {
        let id = id_of(&id)?;
        let mut conn = c.conn(co).await?;
        attribute_defs::update(&mut conn, id, &input).await
    }
    .await;
    ok(r)
}

async fn def_remove(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let co = company!(u);
    let r = async {
        let id = id_of(&id)?;
        let mut conn = c.conn(co).await?;
        attribute_defs::remove(&mut conn, id).await
    }
    .await;
    match r {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => fail(e),
    }
}

async fn project_list(State(c): S, Extension(u): U, Query(q): Query<HashMap<String, String>>) -> Response {
    let co = company!(u);
    let include_inactive = q.get("include_inactive").is_some_and(|v| v == "true");
    let r = async {
        let mut conn = c.conn(co).await?;
        projects::find_all(&mut conn, include_inactive).await
    }
    .await;
    ok(r)
}

async fn project_get(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let co = company!(u);
    let r = async {
        let id = id_of(&id)?;
        let mut conn = c.conn(co).await?;
        projects::find_one(&mut conn, id).await
    }
    .await;
    ok(r)
}

async fn project_create(State(c): S, Extension(u): U, JsonBody(body): JsonBody) -> Response {
    let co = company!(u);
    let input = match dto::create_project(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let r = async {
        let mut conn = c.conn(co).await?;
        projects::create(&mut conn, &input, u.user.user_id).await
    }
    .await;
    ok(r)
}

async fn project_update(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    let co = company!(u);
    let input = match dto::update_project(&body) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let r = async {
        let id = id_of(&id)?;
        let mut conn = c.conn(co).await?;
        projects::update(&mut conn, id, &input).await
    }
    .await;
    ok(r)
}

async fn project_remove(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let co = company!(u);
    let r = async {
        let id = id_of(&id)?;
        let mut conn = c.conn(co).await?;
        projects::remove(&mut conn, id).await
    }
    .await;
    ok(r)
}

/// Router của module: mọi route đi qua `ApiRouter` (khai quyền bắt buộc). Người gọi gắn state `Arc<Ctx>` khi lắp `serve`.
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    // Tải ảnh nhận thân tới 5MB + 1MB (multer giới hạn từng tệp 5MB; mặc định 2MB của axum không đủ).
    let limit = || DefaultBodyLimit::max(PRODUCT_IMAGE_MAX_BYTES + 1024 * 1024);
    ApiRouter::new(deps)
        .route(spec(&Method::GET, "/api/v1/products"), product_list)
        .route(spec(&Method::POST, "/api/v1/products"), product_create)
        .route(
            spec(&Method::POST, "/api/v1/products/upload-image"),
            product_upload.layer(limit()),
        )
        .route(spec(&Method::GET, "/api/v1/products/:id"), product_get)
        .route(spec(&Method::PATCH, "/api/v1/products/:id"), product_update)
        .route(spec(&Method::DELETE, "/api/v1/products/:id"), product_remove)
        .route(spec(&Method::POST, "/api/v1/products/:id/restore"), product_restore)
        .route(spec(&Method::DELETE, "/api/v1/products/:id/permanent"), product_purge)
        .route(spec(&Method::GET, "/api/v1/product-categories"), category_list)
        .route(spec(&Method::POST, "/api/v1/product-categories"), category_create)
        .route(spec(&Method::GET, "/api/v1/product-categories/:id"), category_get)
        .route(spec(&Method::PATCH, "/api/v1/product-categories/:id"), category_update)
        .route(
            spec(&Method::GET, "/api/v1/product-categories/:categoryId/attribute-defs"),
            defs_list,
        )
        .route(
            spec(&Method::POST, "/api/v1/product-categories/:categoryId/attribute-defs"),
            defs_create,
        )
        .route(spec(&Method::PATCH, "/api/v1/product-attribute-defs/:id"), def_update)
        .route(spec(&Method::DELETE, "/api/v1/product-attribute-defs/:id"), def_remove)
        .route(spec(&Method::GET, "/api/v1/projects"), project_list)
        .route(spec(&Method::POST, "/api/v1/projects"), project_create)
        .route(spec(&Method::GET, "/api/v1/projects/:id"), project_get)
        .route(spec(&Method::PATCH, "/api/v1/projects/:id"), project_update)
        .route(spec(&Method::DELETE, "/api/v1/projects/:id"), project_remove)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = specs();
        assert_eq!(table.len(), 21);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 21);
    }
}
