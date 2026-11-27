//! Đơn và thanh toán tại quầy (7 endpoint `/pos/orders`). Bản TS: `pos-orders.service.ts`,
//! `pos-order-items.builder.ts`, `pos-qr.service.ts`. Mọi route đòi `pos.sell`.
//!
//! - Tổng tiền do BE tính từ giá trong DB; client chỉ gửi id món, số lượng, id tuỳ chọn.
//! - Đơn `open` là "sàn chung" (mọi người có `pos.sell` thấy); đơn đã thu/huỷ chỉ khi người tạo hoặc người thu nằm trong
//!   phạm vi `pos.sell` ([`OwnerIds`]); ngoài phạm vi ⇒ 404.
//! - Thu tiền khoá dòng ca `FOR UPDATE` ([`crate::shifts::lock_open_shift`]), còn tạo đơn khoá `FOR SHARE`, và đóng ca
//!   khoá `FOR UPDATE`: đóng ca không thể chen giữa lúc đọc tổng kết và lúc ghi (số tiền mặt dự kiến luôn khớp các khoản
//!   đã thu), và không để sót đơn `open` trong ca đã đóng.
//! - `pos.order.completed` ghi outbox CÙNG giao dịch với việc chuyển đơn sang `paid` (K36).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Acquire, PgConnection, Postgres, QueryBuilder};
use trinity_db::models::{PosOrder, PosOrderItem, PosPayment, PosSettings};
use trinity_db::outbox::{OutboxError, publish_integration_event};
use trinity_db::pg_error::{app_error, db_error};
use trinity_db::types::{JsBigInt, JsonValue, Timestamp};
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};
use trinity_kernel::vn_time::js_iso_string;
use trinity_rbac::OwnerIds;

use crate::money::{ModifierSnapshot, PaymentInput, build_payment_rows, calc_line_total, calc_totals};
use crate::reports::today_vn;
use crate::shifts::{LockMode, lock_open_shift};
use crate::vietqr::build_vietqr;
use crate::{MAX_MONEY, finish, len16, range, trim, trim_opt};

const INT4_MAX: i64 = 2_147_483_647;
const MAX_QTY: i64 = 999;
const NOT_FOUND: &str = "Không tìm thấy đơn";

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

fn outbox(e: OutboxError) -> AppError {
    match e {
        OutboxError::Sqlx(e) => app_error(&e),
        other => HttpError::new(500, other.to_string()).into(),
    }
}

// ---------------------------------------------------------------- DTO

/// Một dòng món đầu vào (`OrderItemInputDto`): `product_id` 1..INT4_MAX, `quantity` 1..999, ≤ 20 `modifier_ids`,
/// `note` ≤ 255 (đã trim).
#[derive(Debug, Clone, Deserialize)]
pub struct OrderItemInput {
    pub product_id: i32,
    pub quantity: i32,
    #[serde(default)]
    pub modifier_ids: Option<Vec<i32>>,
    #[serde(default)]
    pub note: Option<String>,
}

fn items_errors(items: &[OrderItemInput], out: &mut Vec<String>) {
    if items.is_empty() {
        out.push("Đơn cần ít nhất 1 món".to_owned());
    }
    if items.len() > 100 {
        out.push("items must contain no more than 100 elements".to_owned());
    }
    for (i, it) in items.iter().enumerate() {
        let mut e = Vec::new();
        range("product_id", it.product_id.into(), 1, INT4_MAX, &mut e);
        range("quantity", it.quantity.into(), 1, MAX_QTY, &mut e);
        if let Some(m) = &it.modifier_ids {
            if m.len() > 20 {
                e.push("modifier_ids must contain no more than 20 elements".to_owned());
            }
            for id in m {
                range("each value in modifier_ids", (*id).into(), 1, INT4_MAX, &mut e);
            }
            let mut seen = m.clone();
            seen.sort_unstable();
            seen.dedup();
            if seen.len() != m.len() {
                e.push("modifier_ids must not contain duplicate values".to_owned());
            }
        }
        if it.note.as_deref().is_some_and(|n| len16(n) > 255) {
            e.push("note must be shorter than or equal to 255 characters".to_owned());
        }
        out.extend(e.into_iter().map(|m| format!("items.{i}.{m}")));
    }
}

fn is_in(field: &str, v: &str, set: &[&str], out: &mut Vec<String>) {
    if !set.contains(&v) {
        out.push(format!(
            "{field} must be one of the following values: {}",
            set.join(", ")
        ));
    }
}

const ORDER_TYPES: [&str; 2] = ["dine_in", "takeaway"];
const DISCOUNT_TYPES: [&str; 3] = ["none", "percent", "amount"];

#[derive(Debug, Clone, Copy)]
struct Fields<'a> {
    table_id: Option<i32>,
    order_type: Option<&'a str>,
    note: Option<&'a str>,
    discount_type: Option<&'a str>,
    discount_value: Option<i64>,
}

fn field_errors(f: Fields<'_>, out: &mut Vec<String>) {
    if let Some(t) = f.table_id {
        range("table_id", t.into(), 1, INT4_MAX, out);
    }
    if let Some(t) = f.order_type {
        is_in("order_type", t, &ORDER_TYPES, out);
    }
    if f.note.is_some_and(|n| len16(n) > 500) {
        out.push("note must be shorter than or equal to 500 characters".to_owned());
    }
    if let Some(t) = f.discount_type {
        is_in("discount_type", t, &DISCOUNT_TYPES, out);
    }
    if let Some(v) = f.discount_value {
        range("discount_value", v, 0, MAX_MONEY, out);
    }
}

fn trim_items(items: &mut [OrderItemInput]) {
    for it in items {
        trim_opt(&mut it.note);
    }
}

/// Body `POST /pos/orders` (`CreateOrderDto`). Không có `price`/`total`.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateOrder {
    #[serde(default)]
    pub table_id: Option<i32>,
    #[serde(default)]
    pub order_type: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub discount_type: Option<String>,
    #[serde(default)]
    pub discount_value: Option<i64>,
    pub items: Vec<OrderItemInput>,
}

impl CreateOrder {
    pub fn normalize(&mut self) {
        trim_opt(&mut self.note);
        trim_items(&mut self.items);
    }
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        field_errors(
            Fields {
                table_id: self.table_id,
                order_type: self.order_type.as_deref(),
                note: self.note.as_deref(),
                discount_type: self.discount_type.as_deref(),
                discount_value: self.discount_value,
            },
            &mut e,
        );
        items_errors(&self.items, &mut e);
        finish(e)
    }
}

/// Body `PATCH /pos/orders/:id`: `items` có gửi = THAY TOÀN BỘ dòng món; `table_id: null` = bỏ gán bàn.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateOrder {
    #[serde(default, deserialize_with = "crate::some_nullable")]
    pub table_id: Option<Option<i32>>,
    #[serde(default)]
    pub order_type: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub discount_type: Option<String>,
    #[serde(default)]
    pub discount_value: Option<i64>,
    #[serde(default)]
    pub items: Option<Vec<OrderItemInput>>,
}

impl UpdateOrder {
    pub fn normalize(&mut self) {
        trim_opt(&mut self.note);
        if let Some(i) = &mut self.items {
            trim_items(i);
        }
    }
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        field_errors(
            Fields {
                table_id: self.table_id.flatten(),
                order_type: self.order_type.as_deref(),
                note: self.note.as_deref(),
                discount_type: self.discount_type.as_deref(),
                discount_value: self.discount_value,
            },
            &mut e,
        );
        if let Some(i) = &self.items {
            items_errors(i, &mut e);
        }
        if self.discount_type.as_deref().is_some_and(|t| t != "none") && self.discount_value.is_none() {
            e.push("discount_value là bắt buộc khi đổi discount_type".to_owned());
        }
        finish(e)
    }
}

/// Body `POST /pos/orders/:id/pay` (`PayOrderDto`): ≤ 5 dòng; mỗi dòng `method` `cash`|`bank_transfer`, `amount`
/// 1..[`MAX_MONEY`], `tendered` 0..[`MAX_MONEY`], `reference` ≤ 100.
#[derive(Debug, Clone, Deserialize)]
pub struct PayOrder {
    pub payments: Vec<PaymentInput>,
}

impl PayOrder {
    pub fn normalize(&mut self) {
        for p in &mut self.payments {
            trim_opt(&mut p.reference);
        }
    }
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if self.payments.len() > 5 {
            e.push("payments must contain no more than 5 elements".to_owned());
        }
        for (i, p) in self.payments.iter().enumerate() {
            let mut x = Vec::new();
            is_in("method", &p.method, &["cash", "bank_transfer"], &mut x);
            range("amount", p.amount, 1, MAX_MONEY, &mut x);
            if let Some(t) = p.tendered {
                range("tendered", t, 0, MAX_MONEY, &mut x);
            }
            if p.reference.as_deref().is_some_and(|r| len16(r) > 100) {
                x.push("reference must be shorter than or equal to 100 characters".to_owned());
            }
            e.extend(x.into_iter().map(|m| format!("payments.{i}.{m}")));
        }
        finish(e)
    }
}

/// Body `POST /pos/orders/:id/void` (`VoidOrderDto`): `reason` 3..500 (đã trim).
#[derive(Debug, Clone, Deserialize)]
pub struct VoidOrder {
    pub reason: String,
}

impl VoidOrder {
    pub fn normalize(&mut self) {
        trim(&mut self.reason);
    }
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if len16(&self.reason) > 500 {
            e.push("reason must be shorter than or equal to 500 characters".to_owned());
        }
        if len16(&self.reason) < 3 {
            e.push("Nhập lý do huỷ (≥ 3 ký tự)".to_owned());
        }
        finish(e)
    }
}

/// Query `GET /pos/orders` (`ListOrdersQueryDto`): `limit` 1..100 (mặc định 50).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ListOrders {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub table_id: Option<i32>,
    #[serde(default)]
    pub shift_id: Option<i32>,
    #[serde(default)]
    pub cursor: Option<i32>,
    #[serde(default)]
    pub limit: Option<i64>,
}

impl ListOrders {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(s) = &self.status {
            is_in("status", s, &["open", "paid", "void"], &mut e);
        }
        for (name, v) in [
            ("table_id", self.table_id),
            ("shift_id", self.shift_id),
            ("cursor", self.cursor),
        ] {
            if let Some(v) = v {
                range(name, v.into(), 1, INT4_MAX, &mut e);
            }
        }
        if let Some(l) = self.limit {
            range("limit", l, 1, 100, &mut e);
        }
        finish(e)
    }
}

/// Query `GET /pos/orders/:id/qr` (`QrQueryDto`): `amount` 1..[`MAX_MONEY`].
#[derive(Debug, Clone, Default, Deserialize)]
pub struct QrQuery {
    #[serde(default)]
    pub amount: Option<i64>,
}

impl QrQuery {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(a) = self.amount {
            range("amount", a, 1, MAX_MONEY, &mut e);
        }
        finish(e)
    }
}

// ---------------------------------------------------------------- JSON trả về

#[derive(Debug, Clone, Serialize)]
pub struct ItemView {
    pub id: i32,
    pub product_id: i32,
    pub product_name: String,
    pub unit_price: JsBigInt,
    pub quantity: i32,
    pub options: JsonValue,
    pub note: Option<String>,
    pub line_total: JsBigInt,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaymentView {
    pub id: i32,
    pub method: String,
    pub amount: JsBigInt,
    pub tendered: Option<JsBigInt>,
    pub change: JsBigInt,
    pub reference: Option<String>,
    pub shift_id: i32,
    pub created_at: Timestamp,
}

/// Đơn đầy đủ, đúng thứ tự khoá của `toOrderDto`.
#[derive(Debug, Clone, Serialize)]
pub struct OrderView {
    pub id: i32,
    pub code: String,
    pub shift_id: i32,
    pub table_id: Option<i32>,
    pub order_type: String,
    pub status: String,
    pub note: Option<String>,
    pub subtotal: JsBigInt,
    pub discount_type: String,
    pub discount_value: JsBigInt,
    pub discount_amount: JsBigInt,
    pub total: JsBigInt,
    pub created_by: i32,
    pub created_at: Timestamp,
    pub paid_by: Option<i32>,
    pub paid_at: Option<Timestamp>,
    pub voided_by: Option<i32>,
    pub voided_at: Option<Timestamp>,
    pub void_reason: Option<String>,
    pub items: Vec<ItemView>,
    pub payments: Vec<PaymentView>,
}

impl OrderView {
    fn new(o: PosOrder, items: Vec<PosOrderItem>, payments: Vec<PosPayment>) -> Self {
        Self {
            id: o.id,
            code: o.code,
            shift_id: o.shift_id,
            table_id: o.table_id,
            order_type: o.order_type,
            status: o.status,
            note: o.note,
            subtotal: o.subtotal,
            discount_type: o.discount_type,
            discount_value: o.discount_value,
            discount_amount: o.discount_amount,
            total: o.total,
            created_by: o.created_by,
            created_at: o.created_at,
            paid_by: o.paid_by,
            paid_at: o.paid_at,
            voided_by: o.voided_by,
            voided_at: o.voided_at,
            void_reason: o.void_reason,
            items: items
                .into_iter()
                .map(|i| ItemView {
                    id: i.id,
                    product_id: i.product_id,
                    product_name: i.product_name,
                    unit_price: i.unit_price,
                    quantity: i.quantity,
                    options: i.options,
                    note: i.note,
                    line_total: i.line_total,
                })
                .collect(),
            payments: payments
                .into_iter()
                .map(|p| PaymentView {
                    id: p.id,
                    method: p.method,
                    amount: p.amount,
                    tendered: p.tendered,
                    change: p.change,
                    reference: p.reference,
                    shift_id: p.shift_id,
                    created_at: p.created_at,
                })
                .collect(),
        }
    }
}

/// `GET /pos/orders`: mới nhất trước; `next_cursor` = id đơn cuối trang nếu còn.
#[derive(Debug, Clone, Serialize)]
pub struct OrderPage {
    pub data: Vec<OrderView>,
    pub next_cursor: Option<i32>,
}

/// `GET /pos/orders/:id/qr`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QrView {
    pub payload: String,
    pub amount: i64,
    pub content: String,
    pub bank_bin: String,
    pub account_no: String,
    pub account_name: Option<String>,
}

// ---------------------------------------------------------------- truy vấn

const ORDER_COLS: &str = "id, code, shift_id, table_id, order_type, status, note, subtotal, discount_type, \
    discount_value, discount_amount, total, created_by, created_at, updated_at, paid_by, paid_at, voided_by, voided_at, void_reason";
const ITEM_COLS: &str =
    "id, order_id, product_id, product_name, unit_price, quantity, options, note, line_total, created_at";
const PAY_COLS: &str = "id, order_id, shift_id, method, amount, tendered, change, reference, created_by, created_at";

async fn fetch_order(conn: &mut PgConnection, id: i32, lock: bool) -> Result<Option<PosOrder>, AppError> {
    let sql = format!(
        "SELECT {ORDER_COLS} FROM pos_orders WHERE id = $1{}",
        if lock { " FOR UPDATE" } else { "" }
    );
    sqlx::query_as::<_, PosOrder>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)
}

async fn items_of(conn: &mut PgConnection, order_ids: &[i32]) -> Result<Vec<PosOrderItem>, AppError> {
    sqlx::query_as::<_, PosOrderItem>(sqlx::AssertSqlSafe(format!(
        "SELECT {ITEM_COLS} FROM pos_order_items WHERE order_id = ANY($1) ORDER BY id ASC"
    )))
    .bind(order_ids)
    .fetch_all(conn)
    .await
    .map_err(db)
}

async fn payments_of(conn: &mut PgConnection, order_ids: &[i32]) -> Result<Vec<PosPayment>, AppError> {
    sqlx::query_as::<_, PosPayment>(sqlx::AssertSqlSafe(format!(
        "SELECT {PAY_COLS} FROM pos_payments WHERE order_id = ANY($1) ORDER BY id ASC"
    )))
    .bind(order_ids)
    .fetch_all(conn)
    .await
    .map_err(db)
}

async fn assemble(conn: &mut PgConnection, orders: Vec<PosOrder>) -> Result<Vec<OrderView>, AppError> {
    let ids: Vec<i32> = orders.iter().map(|o| o.id).collect();
    let items = items_of(&mut *conn, &ids).await?;
    let pays = payments_of(conn, &ids).await?;
    Ok(orders
        .into_iter()
        .map(|o| {
            let its = items.iter().filter(|i| i.order_id == o.id).cloned().collect();
            let ps = pays.iter().filter(|p| p.order_id == o.id).cloned().collect();
            OrderView::new(o, its, ps)
        })
        .collect())
}

fn visible(o: &PosOrder, owner: &OwnerIds) -> bool {
    o.status == "open" || owner.contains_any(&[Some(o.created_by), o.paid_by])
}

/// `GET /pos/orders/:id`: đơn `open`, hoặc đơn của người trong phạm vi `pos.sell`; còn lại 404.
pub async fn get_by_id(conn: &mut PgConnection, id: i32, owner: &OwnerIds) -> Result<OrderView, AppError> {
    let o = fetch_order(&mut *conn, id, false)
        .await?
        .filter(|o| visible(o, owner))
        .ok_or_else(|| HttpError::not_found(NOT_FOUND))?;
    Ok(assemble(conn, vec![o]).await?.remove(0))
}

/// `GET /pos/orders`.
pub async fn list(conn: &mut PgConnection, q: &ListOrders, owner: &OwnerIds) -> Result<OrderPage, AppError> {
    let take = q.limit.unwrap_or(50);
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(format!("SELECT {ORDER_COLS} FROM pos_orders WHERE "));
    if matches!(owner, OwnerIds::All) {
        qb.push("TRUE");
    } else {
        qb.push("(status = 'open' OR ");
        trinity_rbac::push_scope(&mut qb, owner, &["created_by", "paid_by"]);
        qb.push(")");
    }
    if let Some(s) = &q.status {
        qb.push(" AND status = ").push_bind(s.clone());
    }
    if let Some(t) = q.table_id {
        qb.push(" AND table_id = ").push_bind(t);
    }
    if let Some(s) = q.shift_id {
        qb.push(" AND shift_id = ").push_bind(s);
    }
    if let Some(c) = q.cursor {
        qb.push(" AND id < ").push_bind(c);
    }
    qb.push(" ORDER BY id DESC LIMIT ").push_bind(take + 1);
    let mut rows = qb
        .build_query_as::<PosOrder>()
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    let more = i64::try_from(rows.len()).is_ok_and(|n| n > take);
    rows.truncate(usize::try_from(take).unwrap_or(0));
    let next_cursor = if more { rows.last().map(|o| o.id) } else { None };
    Ok(OrderPage {
        data: assemble(conn, rows).await?,
        next_cursor,
    })
}

// ---------------------------------------------------------------- dựng dòng món

struct BuiltItem {
    product_id: i32,
    product_name: String,
    unit_price: i64,
    quantity: i32,
    options: Vec<ModifierSnapshot>,
    note: Option<String>,
    line_total: i64,
}

/// Tra GIÁ và TUỲ CHỌN từ DB (không tin client), chụp tên/giá. Chỉ bán món đang bán, chưa xoá, có giá và nằm trong menu
/// cấu hình (`menu_category_ids`).
async fn build_items(conn: &mut PgConnection, items: &[OrderItemInput]) -> Result<Vec<BuiltItem>, AppError> {
    let pids: Vec<i32> = items.iter().map(|i| i.product_id).collect();
    let mids: Vec<i32> = items
        .iter()
        .flat_map(|i| i.modifier_ids.clone().unwrap_or_default())
        .collect();
    let products: Vec<(i32, String, i64, Option<i32>)> = sqlx::query_as(
        "SELECT id, name, price, category_id FROM products \
         WHERE id = ANY($1) AND is_active AND deleted_at IS NULL AND price IS NOT NULL \
           AND (category_id IS NULL OR category_id IN (SELECT id FROM product_categories WHERE is_active))",
    )
    .bind(&pids)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let mods: Vec<(i32, String, String, i64)> =
        sqlx::query_as("SELECT id, group_name, name, price_delta FROM pos_modifiers WHERE id = ANY($1) AND is_active")
            .bind(&mids)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    let cats: Vec<i32> =
        sqlx::query_scalar::<_, Option<Vec<i32>>>("SELECT menu_category_ids FROM pos_settings WHERE id = 1")
            .fetch_optional(conn)
            .await
            .map_err(db)?
            .flatten()
            .unwrap_or_default();
    items
        .iter()
        .map(|it| {
            let p = products
                .iter()
                .find(|p| p.0 == it.product_id)
                .filter(|p| cats.is_empty() || p.3.is_some_and(|c| cats.contains(&c)))
                .ok_or_else(|| {
                    HttpError::bad_request(format!(
                        "Món #{} không tồn tại, đã ngừng bán hoặc không có trong menu POS",
                        it.product_id
                    ))
                })?;
            let options = it
                .modifier_ids
                .iter()
                .flatten()
                .map(|id| {
                    mods.iter()
                        .find(|m| m.0 == *id)
                        .map(|m| ModifierSnapshot {
                            id: m.0,
                            group_name: m.1.clone(),
                            name: m.2.clone(),
                            price_delta: m.3,
                        })
                        .ok_or_else(|| HttpError::bad_request(format!("Tuỳ chọn #{id} không tồn tại hoặc đã tắt")))
                })
                .collect::<Result<Vec<_>, _>>()?;
            let line_total = calc_line_total(p.2, &options, it.quantity.into())?;
            Ok(BuiltItem {
                product_id: p.0,
                product_name: p.1.clone(),
                unit_price: p.2,
                quantity: it.quantity,
                options,
                note: it
                    .note
                    .as_deref()
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                    .map(str::to_owned),
                line_total,
            })
        })
        .collect()
}

/// Khoá CHIA SẺ (`FOR SHARE`) các dòng `products` mà đơn sắp tham chiếu, trong cùng giao dịch ghi dòng đơn: `DELETE
/// /products/:id` khoá `FOR UPDATE` rồi đếm tham chiếu, nên hai phía loại trừ nhau (xoá thấy tham chiếu ⇒ 409, hoặc đơn
/// thấy món mất ⇒ 409 ở đây).
async fn lock_products(conn: &mut PgConnection, items: &[BuiltItem]) -> Result<(), AppError> {
    let mut ids: Vec<i32> = items.iter().map(|i| i.product_id).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok(());
    }
    let found: Vec<(i32, bool, Option<i64>)> = sqlx::query_as(
        "SELECT id, is_active, price FROM products WHERE id = ANY($1) AND deleted_at IS NULL ORDER BY id FOR SHARE",
    )
    .bind(&ids)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    if found.len() != ids.len() {
        return Err(
            HttpError::conflict("Có món vừa bị xoá khỏi danh mục sản phẩm — tải lại menu rồi tạo lại đơn").into(),
        );
    }
    // Khoá đã giữ nên giá và trạng thái không đổi được nữa: kiểm lại với giá lúc dựng dòng (đã đọc trước khi khoá).
    let stale = items.iter().any(|i| {
        found
            .iter()
            .find(|f| f.0 == i.product_id)
            .is_none_or(|f| !f.1 || f.2 != Some(i.unit_price))
    });
    if stale {
        return Err(HttpError::conflict("Giá hoặc trạng thái món vừa thay đổi — tải lại menu rồi tạo lại đơn").into());
    }
    Ok(())
}

async fn insert_items(conn: &mut PgConnection, order_id: i32, items: &[BuiltItem]) -> Result<(), AppError> {
    for b in items {
        sqlx::query(
            "INSERT INTO pos_order_items (order_id, product_id, product_name, unit_price, quantity, options, note, line_total) \
             VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8)",
        )
        .bind(order_id)
        .bind(b.product_id)
        .bind(&b.product_name)
        .bind(b.unit_price)
        .bind(b.quantity)
        .bind(serde_json::to_string(&b.options).unwrap_or_else(|_| "[]".into()))
        .bind(&b.note)
        .bind(b.line_total)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    }
    Ok(())
}

async fn assert_table(conn: &mut PgConnection, table_id: Option<i32>) -> Result<(), AppError> {
    let Some(id) = table_id else { return Ok(()) };
    let t: Option<i32> = sqlx::query_scalar("SELECT id FROM pos_tables WHERE id = $1 AND is_active")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    t.map(|_| ())
        .ok_or_else(|| HttpError::bad_request("Bàn không tồn tại hoặc đã tắt").into())
}

// ---------------------------------------------------------------- ghi

/// Mã đơn kế tiếp `YYYYMMDD-NNNN` (giờ VN). Khoá advisory theo giao dịch để hai đơn đồng thời không trùng mã.
async fn next_code(conn: &mut PgConnection, now: DateTime<Utc>) -> Result<String, AppError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.pos_orders.code'))")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let ymd = today_vn(now).format("%Y%m%d").to_string();
    let last: Option<String> = sqlx::query_scalar(
        "SELECT code FROM pos_orders WHERE code LIKE $1 ORDER BY length(code) DESC, code DESC LIMIT 1",
    )
    .bind(format!("{ymd}-%"))
    .fetch_optional(conn)
    .await
    .map_err(db)?;
    let n = last
        .and_then(|c| c.get(9..).and_then(|s| s.parse::<u32>().ok()))
        .unwrap_or(0)
        + 1;
    Ok(format!("{ymd}-{n:04}"))
}

/// `POST /pos/orders`: chưa mở ca ⇒ 400; món/tuỳ chọn/bàn không hợp lệ ⇒ 400; món vừa bị xoá ⇒ 409.
pub async fn create(
    conn: &mut PgConnection,
    user_id: i32,
    input: &CreateOrder,
    now: DateTime<Utc>,
    owner: &OwnerIds,
) -> Result<OrderView, AppError> {
    let mut tx = conn.begin().await.map_err(db)?;
    // Khoá chia sẻ dòng ca: đóng ca (FOR UPDATE) phải chờ đơn đang tạo, nên không sót đơn `open` trong ca đã đóng.
    let shift = lock_open_shift(&mut tx, user_id, LockMode::Share).await?;
    let built = build_items(&mut tx, &input.items).await?;
    let kind = input.discount_type.as_deref().unwrap_or("none");
    let value = input.discount_value.unwrap_or(0);
    let totals = calc_totals(&built.iter().map(|b| b.line_total).collect::<Vec<_>>(), kind, value)?;
    assert_table(&mut tx, input.table_id).await?;
    lock_products(&mut tx, &built).await?;
    let code = next_code(&mut tx, now).await?;
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO pos_orders (code, shift_id, table_id, order_type, note, subtotal, discount_type, discount_value, \
         discount_amount, total, created_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now()) RETURNING id",
    )
    .bind(&code)
    .bind(shift)
    .bind(input.table_id)
    .bind(input.order_type.as_deref().unwrap_or("dine_in"))
    .bind(input.note.as_deref().filter(|n| !n.is_empty()))
    .bind(totals.subtotal)
    .bind(kind)
    .bind(if kind == "none" { 0 } else { value })
    .bind(totals.discount_amount)
    .bind(totals.total)
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        let d = db_error(&e);
        if d.is(DbErrorKind::UniqueViolation, None) {
            AppError::from(HttpError::conflict("Không sinh được mã đơn, thử lại"))
        } else {
            AppError::from(d)
        }
    })?;
    insert_items(&mut tx, id, &built).await?;
    tx.commit().await.map_err(db)?;
    get_by_id(conn, id, owner).await
}

/// `PATCH /pos/orders/:id`: chỉ đơn `open` (409 nếu khác). Khoá dòng đơn nên không sửa đè đơn đang được thu.
pub async fn update(
    conn: &mut PgConnection,
    id: i32,
    input: &UpdateOrder,
    owner: &OwnerIds,
) -> Result<OrderView, AppError> {
    let mut tx = conn.begin().await.map_err(db)?;
    let cur = fetch_order(&mut tx, id, true)
        .await?
        .ok_or_else(|| HttpError::not_found(NOT_FOUND))?;
    if cur.status != "open" {
        return Err(HttpError::conflict("Chỉ sửa được đơn đang mở").into());
    }
    if let Some(t) = input.table_id {
        assert_table(&mut tx, t).await?;
    }
    let built = match &input.items {
        Some(items) => Some(build_items(&mut tx, items).await?),
        None => None,
    };
    let lines: Vec<i64> = match &built {
        Some(b) => b.iter().map(|x| x.line_total).collect(),
        None => items_of(&mut tx, &[id]).await?.iter().map(|i| i.line_total.0).collect(),
    };
    let kind = input.discount_type.clone().unwrap_or_else(|| cur.discount_type.clone());
    let value = input.discount_value.unwrap_or(cur.discount_value.0);
    let value = if kind == "none" { 0 } else { value };
    let totals = calc_totals(&lines, &kind, value)?;
    if let Some(b) = &built {
        lock_products(&mut tx, b).await?;
    }
    let (set_table, table) = match input.table_id {
        Some(t) => (true, t),
        None => (false, None),
    };
    sqlx::query(
        "UPDATE pos_orders SET table_id = CASE WHEN $2 THEN $3 ELSE table_id END, order_type = COALESCE($4, order_type), \
         note = CASE WHEN $5 THEN $6 ELSE note END, subtotal = $7, discount_type = $8, discount_value = $9, \
         discount_amount = $10, total = $11, updated_at = now() WHERE id = $1 AND status = 'open'",
    )
    .bind(id)
    .bind(set_table)
    .bind(table)
    .bind(input.order_type.as_deref())
    .bind(input.note.is_some())
    .bind(input.note.as_deref().filter(|n| !n.is_empty()))
    .bind(totals.subtotal)
    .bind(&kind)
    .bind(value)
    .bind(totals.discount_amount)
    .bind(totals.total)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    if let Some(b) = &built {
        sqlx::query("DELETE FROM pos_order_items WHERE order_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        insert_items(&mut tx, id, b).await?;
    }
    tx.commit().await.map_err(db)?;
    get_by_id(conn, id, owner).await
}

fn iso(t: Timestamp) -> String {
    js_iso_string(t.0)
}

/// Ảnh chụp đơn cho sự kiện `pos.order.completed` (cùng khoá và kiểu với `snapshotPosOrder`: tiền là chuỗi, ngày ISO).
fn snapshot(o: &OrderView) -> Value {
    json!({
        "id": o.id, "code": o.code, "status": o.status, "order_type": o.order_type, "table_id": o.table_id,
        "shift_id": o.shift_id, "note": o.note, "subtotal": o.subtotal.0.to_string(), "discount_type": o.discount_type,
        "discount_amount": o.discount_amount.0.to_string(), "total": o.total.0.to_string(), "created_by": o.created_by,
        "paid_by": o.paid_by, "paid_at": o.paid_at.map(iso), "created_at": iso(o.created_at),
        "items": o.items.iter().map(|i| json!({
            "product_id": i.product_id, "product_name": i.product_name, "unit_price": i.unit_price.0.to_string(),
            "quantity": i.quantity, "line_total": i.line_total.0.to_string(),
        })).collect::<Vec<_>>(),
        "payments": o.payments.iter().map(|p| json!({
            "method": p.method, "amount": p.amount.0.to_string(), "reference": p.reference,
        })).collect::<Vec<_>>(),
    })
}

/// `POST /pos/orders/:id/pay`: chưa mở ca ⇒ 400; đơn không còn `open` ⇒ 409; tổng các dòng phải đúng bằng tổng đơn
/// trong DB. Khoá dòng ca `FOR UPDATE` rồi khoá dòng đơn: thu tiền và đóng ca nối tiếp nhau, tiền ghi vào ca của người thu.
pub async fn pay(
    conn: &mut PgConnection,
    id: i32,
    user_id: i32,
    input: &PayOrder,
    owner: &OwnerIds,
) -> Result<OrderView, AppError> {
    let mut tx = conn.begin().await.map_err(db)?;
    let shift = lock_open_shift(&mut tx, user_id, LockMode::Update).await?;
    let order = fetch_order(&mut tx, id, true)
        .await?
        .ok_or_else(|| HttpError::not_found(NOT_FOUND))?;
    if order.status != "open" {
        return Err(HttpError::conflict("Đơn đã được thanh toán hoặc đã huỷ").into());
    }
    let mut rows = build_payment_rows(&input.payments, order.total.0)?;
    if rows.is_empty() {
        // Đơn 0đ vẫn cần một dòng thu 0đ: số đơn đã thu của ca đếm theo dòng thanh toán, và dòng này gắn đơn vào ca.
        rows.push(crate::money::PaymentRow {
            method: "cash".into(),
            amount: 0,
            tendered: Some(0),
            change: 0,
            reference: None,
        });
    }
    sqlx::query(
        "UPDATE pos_orders SET status = 'paid', paid_by = $2, paid_at = now(), updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    for r in &rows {
        sqlx::query(
            "INSERT INTO pos_payments (order_id, shift_id, method, amount, tendered, change, reference, created_by) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(id)
        .bind(shift)
        .bind(&r.method)
        .bind(r.amount)
        .bind(r.tendered)
        .bind(r.change)
        .bind(&r.reference)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    }
    let paid = fetch_order(&mut tx, id, false)
        .await?
        .ok_or_else(|| HttpError::not_found(NOT_FOUND))?;
    let view = assemble(&mut tx, vec![paid]).await?.remove(0);
    publish_integration_event(
        &mut tx,
        "pos.order.completed",
        &json!({ "order": snapshot(&view) }),
        id,
        Some(user_id),
    )
    .await
    .map_err(outbox)?;
    tx.commit().await.map_err(db)?;
    get_by_id(conn, id, owner).await
}

/// `POST /pos/orders/:id/void`: không thấy ⇒ 404; đã huỷ ⇒ 409; đã thu mà không có `pos.manage` (`can_manage`) ⇒ 403
/// (tiền không còn tính vào doanh thu và đối soát ca).
pub async fn void_order(
    conn: &mut PgConnection,
    id: i32,
    user_id: i32,
    input: &VoidOrder,
    can_manage: bool,
    owner: &OwnerIds,
) -> Result<OrderView, AppError> {
    let cur = fetch_order(&mut *conn, id, false)
        .await?
        .filter(|o| visible(o, owner))
        .ok_or_else(|| HttpError::not_found(NOT_FOUND))?;
    if cur.status == "void" {
        return Err(HttpError::conflict("Đơn đã huỷ").into());
    }
    if cur.status == "paid" && !can_manage {
        return Err(HttpError::forbidden("Cần quyền quản lý POS (pos.manage) để huỷ đơn đã thu tiền").into());
    }
    let mut tx = conn.begin().await.map_err(db)?;
    if cur.status == "paid" {
        // Huỷ đơn đã thu làm đổi tiền của các ca nhận tiền: khoá các ca đó `FOR UPDATE` (cùng thứ tự id, và TRƯỚC khoá dòng
        // đơn như `pay`, để không bế tắc), nên đóng ca không thể chen giữa. Ca đã đóng thì số liệu đã chốt: 409.
        let shifts: Vec<(i32, String)> = sqlx::query_as(
            "SELECT id, status FROM pos_shifts WHERE id IN (SELECT shift_id FROM pos_payments WHERE order_id = $1) \
             ORDER BY id FOR UPDATE",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?;
        if shifts.iter().any(|s| s.1 != "open") {
            return Err(HttpError::conflict("Ca nhận tiền của đơn đã đóng, không huỷ được đơn đã thu").into());
        }
    }
    let locked = fetch_order(&mut tx, id, true)
        .await?
        .ok_or_else(|| HttpError::not_found(NOT_FOUND))?;
    if locked.status != cur.status {
        return Err(HttpError::conflict("Trạng thái đơn vừa thay đổi, tải lại").into());
    }
    sqlx::query(
        "UPDATE pos_orders SET status = 'void', voided_by = $2, voided_at = now(), void_reason = $3, updated_at = now() \
         WHERE id = $1",
    )
    .bind(id)
    .bind(user_id)
    .bind(&input.reason)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    get_by_id(conn, id, owner).await
}

/// `GET /pos/orders/:id/qr`: chỉ đơn `open`; số tiền mặc định = tổng đơn, tối đa = tổng đơn; nội dung `HD<mã đơn bỏ gạch>`.
pub async fn qr(conn: &mut PgConnection, id: i32, requested: Option<i64>) -> Result<QrView, AppError> {
    let order = fetch_order(&mut *conn, id, false)
        .await?
        .ok_or_else(|| HttpError::not_found(NOT_FOUND))?;
    if order.status != "open" {
        return Err(HttpError::bad_request("Chỉ tạo QR cho đơn đang mở").into());
    }
    let s = sqlx::query_as::<_, PosSettings>(
        "SELECT id, store_name, address, phone, receipt_footer, bank_bin, bank_account_no, bank_account_name, \
         menu_category_ids, updated_at FROM pos_settings WHERE id = 1",
    )
    .fetch_optional(conn)
    .await
    .map_err(db)?;
    let (Some(bin), Some(acc)) = (
        s.as_ref().and_then(|s| s.bank_bin.clone()).filter(|b| !b.is_empty()),
        s.as_ref()
            .and_then(|s| s.bank_account_no.clone())
            .filter(|a| !a.is_empty()),
    ) else {
        return Err(HttpError::bad_request("Chưa cấu hình tài khoản nhận tiền (Cài đặt POS > Ngân hàng)").into());
    };
    let total = order.total.0;
    let amount = requested.unwrap_or(total);
    if amount < 1 || amount > total {
        return Err(HttpError::bad_request("Số tiền QR phải trong khoảng 1 → tổng đơn").into());
    }
    let content = format!("HD{}", order.code.replacen('-', "", 1));
    let payload = build_vietqr(&bin, &acc, Some(amount), Some(&content)).map_err(|m| HttpError::new(500, m))?;
    Ok(QrView {
        payload,
        amount,
        content,
        bank_bin: bin,
        account_no: acc,
        account_name: s.and_then(|s| s.bank_account_name),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(q: i32) -> OrderItemInput {
        OrderItemInput {
            product_id: 1,
            quantity: q,
            modifier_ids: None,
            note: None,
        }
    }

    #[test]
    fn kiem_luat_dto_don() {
        let ok = CreateOrder {
            table_id: None,
            order_type: None,
            note: None,
            discount_type: Some("percent".into()),
            discount_value: Some(10),
            items: vec![item(2)],
        };
        assert!(ok.validate().is_ok());
        let bad = CreateOrder {
            table_id: Some(0),
            order_type: Some("x".into()),
            note: None,
            discount_type: None,
            discount_value: None,
            items: vec![],
        };
        assert_eq!(bad.validate().unwrap_err().status(), 400);
        let q = CreateOrder {
            items: vec![item(1000)],
            ..ok.clone()
        };
        assert!(q.validate().is_err());
        assert!(
            PayOrder {
                payments: vec![PaymentInput {
                    method: "momo".into(),
                    amount: 1,
                    tendered: None,
                    reference: None
                }]
            }
            .validate()
            .is_err()
        );
        assert!(VoidOrder { reason: "ab".into() }.validate().is_err());
        let mut v = VoidOrder {
            reason: "  hết món ".into(),
        };
        v.normalize();
        assert_eq!(v.reason, "hết món");
        assert!(
            ListOrders {
                status: Some("paid".into()),
                limit: Some(100),
                ..Default::default()
            }
            .validate()
            .is_ok()
        );
        assert!(QrQuery { amount: Some(0) }.validate().is_err());
    }

    #[test]
    fn cap_nhat_phan_biet_null_va_vang() {
        let a: UpdateOrder = serde_json::from_str(r#"{"table_id":null}"#).unwrap();
        assert_eq!(a.table_id, Some(None));
        let b: UpdateOrder = serde_json::from_str("{}").unwrap();
        assert_eq!(b.table_id, None);
    }
}
