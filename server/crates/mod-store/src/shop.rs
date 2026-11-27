//! Trang công khai (`GET /store/public/:slug`, `POST /store/public/:slug/orders`, `GET /store/public/:slug/orders/:code`) và đơn
//! (`GET /store/orders`, `PATCH /store/orders/:id`), chuyển từ `store.service.ts`.
//!
//! Thanh toán: COD hoặc chuyển khoản bằng QR VietQR tĩnh sinh tại chỗ, nội dung = mã đơn; KHÔNG tự khớp tiền — đơn ở trạng thái
//! `new` tới khi nhân viên xác nhận. Sự kiện `store_order.created` ghi outbox CÙNG giao dịch với lúc tạo đơn (cả hai cách thanh
//! toán); đổi trạng thái ghi `store_order.status_changed` (và `store_order.paid` khi sang `paid`).

use std::sync::Arc;

use mod_contacts::third_party::{Owner, ThirdPartyContact, create_in_tx};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection, Row};
use trinity_db::outbox::publish_integration_event;
use trinity_db::types::{JsBigInt, Timestamp};
use trinity_http::rate_limit::{FixedWindowLimiter, now_ms};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::phone::{normalize_phone, phone_variants};
use trinity_rbac::{OwnerIds, PhoneMasker, assert_in_scope};

use crate::settings::{self, StoreSettings, bank_account_of, js_num, js_str, slice16};
use crate::{db, vietqr};

pub const STORE_ORDER_STATUSES: [&str; 6] = ["new", "confirmed", "paid", "shipped", "done", "cancelled"];
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Lỗi của đường đặt đơn: lỗi thường, hoặc 429 (kèm số giây chờ cho header `Retry-After`).
#[derive(Debug)]
pub enum StoreError {
    App(AppError),
    /// 429 "Bạn đặt quá nhiều đơn…": body `{ statusCode, message, retryAfter }`.
    RateLimited {
        retry_after_sec: u64,
    },
}

impl From<AppError> for StoreError {
    fn from(e: AppError) -> Self {
        Self::App(e)
    }
}

impl From<HttpError> for StoreError {
    fn from(e: HttpError) -> Self {
        Self::App(e.into())
    }
}

pub const RATE_LIMIT_MESSAGE: &str = "Bạn đặt quá nhiều đơn, vui lòng thử lại sau ít phút.";

fn bad(msg: &str) -> StoreError {
    HttpError::bad_request(msg).into()
}

fn not_found(msg: &str) -> HttpError {
    HttpError::not_found(msg)
}

/// Bộ giới hạn đặt đơn (dựng một lần ở `serve`, dùng chung mọi công ty; khoá có kèm slug/IP).
#[derive(Clone)]
pub struct OrderLimits {
    /// 5 đơn / 10 phút / IP.
    per_ip: Arc<FixedWindowLimiter>,
    /// 300 đơn / 10 phút cho cả trang.
    per_store: Arc<FixedWindowLimiter>,
    /// Trần chung theo IP peer khi IP khách KHÔNG tin được (mọi khách chung một peer): 100 đơn / 10 phút.
    untrusted_peer: Arc<FixedWindowLimiter>,
}

impl Default for OrderLimits {
    fn default() -> Self {
        Self {
            per_ip: FixedWindowLimiter::new(5, 600_000),
            per_store: FixedWindowLimiter::new(300, 600_000),
            untrusted_peer: FixedWindowLimiter::new(100, 600_000),
        }
    }
}

impl OrderLimits {
    /// Khoá giới hạn đặt đơn theo IP khách (hàm dùng chung, `TRUSTED_PROXY`). `ip` = IP tin được (tối đa 45 ký tự); không tin
    /// được ⇒ kiểm trần theo `rate_key` (IP peer) rồi khoá theo SĐT người đặt (khách này không chặn khách khác).
    pub fn client_key(&self, ip: Option<&str>, rate_key: &str, body: &Value) -> Result<String, StoreError> {
        if let Some(ip) = ip {
            return Ok(ip.chars().take(45).collect());
        }
        let peer = self.untrusted_peer.hit(&format!("peer:{rate_key}"), now_ms());
        if !peer.allowed {
            return Err(StoreError::RateLimited {
                retry_after_sec: peer.retry_after_sec,
            });
        }
        let phone: String = body
            .get("phone")
            .and_then(Value::as_str)
            .map(|p| p.chars().filter(char::is_ascii_digit).take(20).collect())
            .unwrap_or_default();
        Ok(format!("u:phone:{}", if phone.is_empty() { "none" } else { &phone }))
    }
}

/// Cửa hàng đang mở (cờ tính năng bật + đã mở bán + đúng địa chỉ); không thì 404 (không lộ là có trang hay không).
/// `feature_enabled` = `online_store` đã tính gói (`org_features::get`), do tầng route tra.
async fn open_store(conn: &mut PgConnection, feature_enabled: bool, slug: &str) -> Result<StoreSettings, AppError> {
    let s = settings::load(conn).await?;
    if !feature_enabled || !s.published || s.slug.is_empty() || s.slug != slug.to_lowercase() {
        return Err(not_found("Không có cửa hàng này.").into());
    }
    Ok(s)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProductOut {
    pub id: i32,
    pub name: String,
    pub price: i64,
    pub image_url: Option<String>,
    pub description: Option<String>,
}

async fn products(conn: &mut PgConnection, ids: &[i64]) -> Result<Vec<ProductOut>, AppError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT id, name, price, image_url, description FROM products
         WHERE id = ANY($1) AND is_active AND deleted_at IS NULL AND price IS NOT NULL",
    )
    .bind(ids.iter().filter_map(|i| i32::try_from(*i).ok()).collect::<Vec<i32>>())
    .fetch_all(conn)
    .await
    .map_err(db)?;
    let mut out: Vec<ProductOut> = rows
        .iter()
        .map(|r| {
            Ok(ProductOut {
                id: r.try_get("id")?,
                name: r.try_get("name")?,
                price: r.try_get("price")?,
                image_url: r.try_get("image_url")?,
                description: r.try_get::<Option<String>, _>("description")?.map(|d| slice16(&d, 600)),
            })
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(db)?;
    // Thứ tự theo danh sách của cửa hàng (`order.get(id) ?? 0` của bản TS: id không có trong danh sách xếp đầu; ở đây các dòng đều thuộc danh sách vì đã lọc theo `ANY($1)`).
    out.sort_by_key(|p| ids.iter().position(|i| *i == i64::from(p.id)).unwrap_or(0));
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PaymentFlags {
    pub cod: bool,
    pub bank_transfer: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublicStore {
    pub name: String,
    pub tagline: Option<String>,
    pub theme: String,
    pub accent: String,
    pub phone: Option<String>,
    pub address: Option<String>,
    pub cover_url: Option<String>,
    pub logo_url: Option<String>,
    pub payment: PaymentFlags,
    pub products: Vec<ProductOut>,
}

/// `GET /store/public/:slug`: thông tin trang + sản phẩm đang bán (giá thật từ danh mục).
pub async fn public_store(conn: &mut PgConnection, feature_enabled: bool, slug: &str) -> Result<PublicStore, AppError> {
    let s = open_store(conn, feature_enabled, slug).await?;
    let products = products(conn, &s.product_ids).await?;
    let bank = bank_account_of(&s).is_some();
    Ok(PublicStore {
        name: s.name,
        tagline: s.tagline,
        theme: s.theme,
        accent: s.accent,
        phone: s.phone,
        address: s.address,
        cover_url: s.cover_url,
        logo_url: s.logo_url,
        payment: PaymentFlags {
            cod: s.cod,
            bank_transfer: bank,
        },
        products,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QrBank {
    pub bin: String,
    pub bank: String,
    pub account_number: String,
    pub account_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QrPayment {
    pub qr_data: String,
    pub transfer_content: String,
    pub bank: QrBank,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlacedOrder {
    pub code: String,
    pub total: i64,
    pub payment_method: String,
    pub payment: Option<QrPayment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct Line {
    product_id: i32,
    name: String,
    price: i64,
    quantity: i64,
}

fn rand_code() -> String {
    let mut b = [0u8; 6];
    getrandom::fill(&mut b).expect("hệ điều hành cấp được byte ngẫu nhiên");
    let tail: String = b
        .iter()
        .map(|x| char::from(CODE_ALPHABET[usize::from(x % 32)]))
        .collect();
    format!("DH-{tail}")
}

/// Khách theo SĐT (trùng khách cũ ⇒ khách đó), chưa có thì tạo. Cùng khoá tư vấn theo SĐT với tạo khách tay / webhook vào.
async fn contact_for(conn: &mut PgConnection, name: &str, phone: &str, owner: Option<Owner>) -> Result<i32, AppError> {
    let mut tx = conn.begin().await.map_err(db)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(phone)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let dup: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM contacts WHERE phone = ANY($1) AND deleted_at IS NULL ORDER BY id ASC LIMIT 1",
    )
    .bind(phone_variants(phone))
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    if let Some(id) = dup {
        tx.commit().await.map_err(db)?;
        return Ok(id);
    }
    // Nhãn nguồn `connector:store` giữ như trước để báo cáo theo nguồn không đứt.
    let id = create_in_tx(
        &mut tx,
        &ThirdPartyContact {
            phone,
            full_name: &slice16(name, 255),
            source_id: None,
            email: None,
            project_id: None,
        },
        owner.unwrap_or(Owner {
            id: None,
            team_id: None,
        }),
        "connector:store",
    )
    .await?;
    sqlx::query(
        "INSERT INTO activities (contact_id, action, details, metadata, created_by) VALUES ($1, 'note', $2::text::jsonb, NULL, NULL)",
    )
    .bind(id)
    .bind(trinity_kernel::json::js_json(&json!({ "description": "Tạo từ trang bán hàng", "source": "connector:store" })))
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(id)
}

/// Ảnh chụp đơn cho sự kiện webhook (`store_order.*`) — chỉ trường lõi.
fn snapshot(r: &sqlx::postgres::PgRow, assigned_to: Option<i32>) -> Result<Value, sqlx::Error> {
    let items: Value = r.try_get("items")?;
    let lines: Vec<Value> = items
        .as_array()
        .map(|a| {
            a.iter()
                .map(|l| {
                    json!({
                        "product_id": js_num(l.get("product_id").unwrap_or(&Value::Null)),
                        "name": js_str(l.get("name").unwrap_or(&Value::Null)),
                        "quantity": js_num(l.get("quantity").unwrap_or(&Value::Null)),
                        "price": js_num(l.get("price").unwrap_or(&Value::Null)),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "id": r.try_get::<i32, _>("id")?, "code": r.try_get::<String, _>("code")?, "status": r.try_get::<String, _>("status")?,
        "customer_name": r.try_get::<String, _>("customer_name")?, "customer_phone": r.try_get::<String, _>("customer_phone")?,
        "customer_address": r.try_get::<Option<String>, _>("customer_address")?, "note": r.try_get::<Option<String>, _>("note")?,
        "items": lines, "total": r.try_get::<i64, _>("total")?, "payment_method": r.try_get::<String, _>("payment_method")?,
        "contact_id": r.try_get::<Option<i32>, _>("contact_id")?, "contact_assigned_to": assigned_to,
        "created_at": trinity_kernel::vn_time::js_iso_string(r.try_get::<Timestamp, _>("created_at")?.0),
    }))
}

const ORDER_COLS: &str = "id, code, status, customer_name, customer_phone, customer_address, note, items, total, payment_method, \
     contact_id, created_at";

fn vnd(n: i64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push('.');
        }
        out.push(c);
    }
    format!("{out}đ")
}

/// `POST /store/public/:slug/orders`. `client_key` = [`OrderLimits::client_key`]. Giá luôn lấy từ danh mục (không tin giá trình
/// duyệt gửi lên). Người nhận khách mới = `owner_user_id` của cấu hình; không còn tồn tại ⇒ khách chưa có người phụ trách.
pub async fn place_order(
    conn: &mut PgConnection,
    limits: &OrderLimits,
    feature_enabled: bool,
    slug: &str,
    client_key: &str,
    body: &Value,
) -> Result<PlacedOrder, StoreError> {
    let s = open_store(conn, feature_enabled, slug).await?;
    for (lim, key) in [
        (&limits.per_ip, format!("ip:{client_key}")),
        (&limits.per_store, format!("store:{}", s.slug)),
    ] {
        let r = lim.hit(&key, now_ms());
        if !r.allowed {
            return Err(StoreError::RateLimited {
                retry_after_sec: r.retry_after_sec,
            });
        }
    }
    let field = |k: &str| body.get(k).map(js_str).unwrap_or_default();
    let name = slice16(settings_trim(&field("name")), 120);
    let phone = normalize_phone(&field("phone"));
    let address = Some(slice16(settings_trim(&field("address")), 300)).filter(|a| !a.is_empty());
    if name.is_empty() {
        return Err(bad("Vui lòng nhập họ tên."));
    }
    let Some(phone) = phone else {
        return Err(bad("Số điện thoại không hợp lệ."));
    };
    let method = if body.get("payment_method").and_then(Value::as_str) == Some("bank_transfer") {
        "bank_transfer"
    } else {
        "cod"
    };
    let pub_store = public_store(conn, feature_enabled, slug).await?;
    if method == "cod" && !pub_store.payment.cod {
        return Err(bad("Cửa hàng không nhận thanh toán khi nhận hàng."));
    }
    if method == "bank_transfer" && !pub_store.payment.bank_transfer {
        return Err(bad("Cửa hàng chưa nhận chuyển khoản."));
    }
    if method == "cod" && address.is_none() {
        return Err(bad("Vui lòng nhập địa chỉ giao hàng."));
    }
    let mut lines: Vec<Line> = Vec::new();
    for it in body
        .get("items")
        .and_then(Value::as_array)
        .map(|a| a.iter().take(30).collect::<Vec<_>>())
        .unwrap_or_default()
    {
        let pid = js_num(it.get("product_id").unwrap_or(&Value::Null));
        let q = js_num(it.get("quantity").unwrap_or(&Value::Null)).map(f64::floor);
        let Some(p) = pid.and_then(|id| pub_store.products.iter().find(|p| f64::from(p.id) == id)) else {
            continue;
        };
        let Some(q) = q.filter(|q| (1.0..=99.0).contains(q)) else {
            continue;
        };
        #[allow(clippy::cast_possible_truncation)]
        lines.push(Line {
            product_id: p.id,
            name: p.name.clone(),
            price: p.price,
            quantity: q as i64,
        });
    }
    if lines.is_empty() {
        return Err(bad("Giỏ hàng trống hoặc sản phẩm không còn bán."));
    }
    // Tổng đơn bằng số học kiểm tràn: giá × số lượng quá lớn ⇒ 400, không panic/tràn âm thầm.
    let total = lines
        .iter()
        .try_fold(0_i64, |acc, l| {
            l.price.checked_mul(l.quantity).and_then(|v| acc.checked_add(v))
        })
        .ok_or_else(|| bad("Tổng đơn quá lớn."))?;
    if method == "bank_transfer" && !(1000..=10_000_000_000).contains(&total) {
        return Err(bad("Tổng đơn phải từ 1.000đ tới 10 tỷ để chuyển khoản."));
    }
    let owner = owner_of(conn, &s).await?;
    let contact_id = contact_for(conn, &name, &phone, owner).await?;
    let assigned_to: Option<i32> = sqlx::query_scalar("SELECT assigned_to FROM contacts WHERE id = $1")
        .bind(contact_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?
        .flatten();
    let note = Some(slice16(settings_trim(&field("note")), 500)).filter(|n| !n.is_empty());
    let items = trinity_kernel::json::js_json(&Value::Array(
        lines
            .iter()
            .map(|l| json!({ "product_id": l.product_id, "name": l.name, "price": l.price, "quantity": l.quantity }))
            .collect(),
    ));
    let mut placed: Option<String> = None;
    for _ in 0..5 {
        let code = rand_code();
        let mut tx = conn.begin().await.map_err(db)?;
        let inserted = sqlx::query(sqlx::AssertSqlSafe(format!(
            "INSERT INTO store_orders (code, customer_name, customer_phone, customer_address, note, items, total, payment_method, contact_id)
             VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9) RETURNING {ORDER_COLS}"
        )))
        .bind(&code)
        .bind(&name)
        .bind(&phone)
        .bind(&address)
        .bind(&note)
        .bind(&items)
        .bind(total)
        .bind(method)
        .bind(contact_id)
        .fetch_one(&mut *tx)
        .await;
        match inserted {
            Ok(row) => {
                let id: i32 = row.try_get("id").map_err(db)?;
                let snap = snapshot(&row, assigned_to).map_err(db)?;
                publish_integration_event(&mut tx, "store_order.created", &json!({ "order": snap }), id, None)
                    .await
                    .map_err(AppError::internal)?;
                tx.commit().await.map_err(db)?;
                placed = Some(code);
                let first3 = lines
                    .iter()
                    .take(3)
                    .map(|l| format!("{} ×{}", l.name, l.quantity))
                    .collect::<Vec<_>>()
                    .join(", ");
                let more = if lines.len() > 3 { "…" } else { "" };
                let how = if method == "cod" { "COD" } else { "chuyển khoản" };
                let desc = format!(
                    "Đơn online {} — {} ({first3}{more}) · {how}",
                    placed.as_deref().unwrap_or(""),
                    vnd(total)
                );
                let r = sqlx::query(
                    "INSERT INTO activities (contact_id, action, details, metadata, created_by)
                     VALUES ($1, 'note', $2::text::jsonb, $3::text::jsonb, NULL)",
                )
                .bind(contact_id)
                .bind(trinity_kernel::json::js_json(
                    &json!({ "description": desc, "source": "store" }),
                ))
                .bind(trinity_kernel::json::js_json(&json!({ "store_order_id": id })))
                .execute(&mut *conn)
                .await;
                if let Err(e) = r {
                    tracing::warn!("Ghi lịch sử đơn online lỗi: {e}");
                }
                break;
            }
            Err(e) => {
                drop(tx);
                let dup_code = matches!(&e, sqlx::Error::Database(d) if d.is_unique_violation());
                if !dup_code {
                    return Err(db(e).into());
                }
            }
        }
    }
    let Some(code) = placed else {
        return Err(bad("Không tạo được đơn, vui lòng thử lại."));
    };
    // Chuyển khoản: QR VietQR tĩnh sinh tại chỗ (không gọi dịch vụ ngoài), nội dung = mã đơn.
    let payment = if method == "bank_transfer" {
        bank_account_of(&s)
            .map(|b| {
                let qr = vietqr::build(b.bin, &b.account, total, &code).map_err(AppError::internal)?;
                Ok::<_, AppError>(QrPayment {
                    qr_data: qr,
                    transfer_content: code.clone(),
                    bank: QrBank {
                        bin: b.bin.to_owned(),
                        bank: b.name.to_owned(),
                        account_number: b.account,
                        account_name: b.account_name,
                    },
                })
            })
            .transpose()?
    } else {
        None
    };
    Ok(PlacedOrder {
        code,
        total,
        payment_method: method.to_owned(),
        payment,
    })
}

fn settings_trim(s: &str) -> &str {
    trinity_kernel::vi::trim_js(s)
}

async fn owner_of(conn: &mut PgConnection, s: &StoreSettings) -> Result<Option<Owner>, AppError> {
    let Some(uid) = s.owner_user_id else { return Ok(None) };
    let row: Option<(i32, Option<i32>)> =
        sqlx::query_as("SELECT id, team_id FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL")
            .bind(uid)
            .fetch_optional(conn)
            .await
            .map_err(db)?;
    Ok(row.map(|(id, team_id)| Owner { id: Some(id), team_id }))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OrderStatusOut {
    pub code: String,
    pub status: String,
    pub total: i64,
    pub payment_method: String,
}

/// `GET /store/public/:slug/orders/:code?phone=`: khách xem lại đơn của mình — phải đúng mã + SĐT đặt hàng (không dò được đơn
/// người khác).
pub async fn order_status(
    conn: &mut PgConnection,
    feature_enabled: bool,
    slug: &str,
    code: &str,
    phone_raw: &str,
) -> Result<OrderStatusOut, AppError> {
    open_store(conn, feature_enabled, slug).await?;
    let phone = normalize_phone(phone_raw);
    let row: Option<(String, String, String, i64, String)> =
        sqlx::query_as("SELECT code, status, customer_phone, total, payment_method FROM store_orders WHERE code = $1")
            .bind(code.to_uppercase())
            .fetch_optional(conn)
            .await
            .map_err(db)?;
    match (row, phone) {
        (Some((code, status, cust, total, payment_method)), Some(p)) if cust == p => Ok(OrderStatusOut {
            code,
            status,
            total,
            payment_method,
        }),
        _ => Err(not_found("Không tìm thấy đơn.").into()),
    }
}

/// Dòng đơn trả cho nhân viên: cột của model, `total` là số, SĐT che theo `contacts.phone_full`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OrderOut {
    pub id: i32,
    pub code: String,
    pub status: String,
    pub customer_name: String,
    pub customer_phone: String,
    pub customer_address: Option<String>,
    pub note: Option<String>,
    pub items: Value,
    pub total: JsBigInt,
    pub payment_method: String,
    pub payment_intent_id: Option<i32>,
    pub contact_id: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

const FULL_COLS: &str = "id, code, status, customer_name, customer_phone, customer_address, note, items, total, payment_method, \
     payment_intent_id, contact_id, created_at, updated_at";

type FullRow = (
    i32,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Value,
    JsBigInt,
    String,
    Option<i32>,
    Option<i32>,
    Timestamp,
    Timestamp,
);

fn out_of(r: FullRow, phone: String) -> OrderOut {
    OrderOut {
        id: r.0,
        code: r.1,
        status: r.2,
        customer_name: r.3,
        customer_phone: phone,
        customer_address: r.5,
        note: r.6,
        items: r.7,
        total: r.8,
        payment_method: r.9,
        payment_intent_id: r.10,
        contact_id: r.11,
        created_at: r.12,
        updated_at: r.13,
    }
}

async fn contact_owners(
    conn: &mut PgConnection,
    ids: &[Option<i32>],
) -> Result<std::collections::HashMap<i32, Option<i32>>, AppError> {
    let list: Vec<i32> = ids.iter().flatten().copied().collect();
    if list.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let rows: Vec<(i32, Option<i32>)> = sqlx::query_as("SELECT id, assigned_to FROM contacts WHERE id = ANY($1)")
        .bind(list)
        .fetch_all(conn)
        .await
        .map_err(db)?;
    Ok(rows.into_iter().collect())
}

/// `GET /store/orders?status=&limit=`: đơn trong phạm vi `deals.view` (`view`) theo người phụ trách khách đã ghép — đơn chưa ghép
/// khách chỉ phạm vi "tất cả". SĐT che theo `contacts.phone_full` (`phone_full`).
pub async fn list_orders(
    conn: &mut PgConnection,
    view: Option<&OwnerIds>,
    phone_full: Option<&OwnerIds>,
    status: Option<&str>,
    limit: Option<&str>,
) -> Result<Vec<OrderOut>, AppError> {
    let limit = limit
        .and_then(js_num_str)
        .filter(|n| *n != 0.0)
        .unwrap_or(50.0)
        .clamp(1.0, 200.0);
    let owners: Option<Vec<i32>> = match view {
        Some(OwnerIds::All) => None,
        Some(OwnerIds::Ids(v)) => Some(v.clone()),
        None => Some(Vec::new()),
    };
    #[allow(clippy::cast_possible_truncation)]
    let limit = limit as i64;
    let rows: Vec<FullRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {FULL_COLS} FROM store_orders
         WHERE ($1::text IS NULL OR status = $1)
           AND ($2::int4[] IS NULL OR contact_id IN (SELECT id FROM contacts WHERE assigned_to = ANY($2) AND deleted_at IS NULL))
         ORDER BY id DESC LIMIT $3"
    )))
    .bind(status.filter(|s| !s.is_empty()))
    .bind(owners)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let owner_of = contact_owners(conn, &rows.iter().map(|r| r.11).collect::<Vec<_>>()).await?;
    let mask = PhoneMasker::new(phone_full.cloned());
    Ok(rows
        .into_iter()
        .map(|r| {
            let owner = r.11.and_then(|c| owner_of.get(&c).copied().flatten());
            let phone = mask.mask(&[owner], Some(&r.4)).unwrap_or_default();
            out_of(r, phone)
        })
        .collect())
}

fn js_num_str(s: &str) -> Option<f64> {
    js_num(&Value::String(s.to_owned()))
}

/// `PATCH /store/orders/:id`: đổi trạng thái; SĐT trả về che theo `contacts.phone_full` (`phone_full`). Ngoài phạm vi `deals.manage` (`manage`) ⇒ 404. Mọi lần đổi ghi
/// `store_order.status_changed`, thêm `store_order.paid` khi sang `paid` (chuyển khoản do nhân viên xác nhận tay).
pub async fn update_order_status(
    conn: &mut PgConnection,
    manage: Option<&OwnerIds>,
    phone_full: Option<&OwnerIds>,
    id: i32,
    status: &str,
) -> Result<OrderOut, AppError> {
    if !STORE_ORDER_STATUSES.contains(&status) {
        return Err(HttpError::bad_request("Trạng thái không hợp lệ.").into());
    }
    let cur: Option<(Option<i32>,)> = sqlx::query_as("SELECT contact_id FROM store_orders WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let Some((contact_id,)) = cur else {
        return Err(not_found("Không có đơn này.").into());
    };
    // Ngoài phạm vi `deals.manage` ⇒ 404 (không lộ là có đơn).
    let assigned = contact_owners(conn, &[contact_id])
        .await?
        .get(&contact_id.unwrap_or(0))
        .copied()
        .flatten();
    assert_in_scope(manage, &[assigned]).map_err(|e| AppError::from(*e))?;
    // Khoá dòng đơn rồi so trạng thái HIỆN TẠI: hai người đổi cùng lúc thì người sau thấy trạng thái đã đổi, không phát sự kiện
    // trùng và `previous_status` luôn đúng.
    let mut tx = conn.begin().await.map_err(db)?;
    let previous: String = sqlx::query_scalar("SELECT status FROM store_orders WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    if previous != status {
        let row = sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE store_orders SET status = $2, updated_at = now() WHERE id = $1 RETURNING {ORDER_COLS}"
        )))
        .bind(id)
        .bind(status)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let order = snapshot(&row, assigned).map_err(db)?;
        publish_integration_event(
            &mut tx,
            "store_order.status_changed",
            &json!({ "order": order, "previous_status": previous }),
            id,
            None,
        )
        .await
        .map_err(AppError::internal)?;
        if status == "paid" {
            publish_integration_event(&mut tx, "store_order.paid", &json!({ "order": order }), id, None)
                .await
                .map_err(AppError::internal)?;
        }
    }
    tx.commit().await.map_err(db)?;
    let full: FullRow = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {FULL_COLS} FROM store_orders WHERE id = $1"
    )))
    .bind(id)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    // SĐT che theo `contacts.phone_full` như danh sách đơn.
    let phone = PhoneMasker::new(phone_full.cloned())
        .mask(&[assigned], Some(&full.4))
        .unwrap_or_default();
    Ok(out_of(full, phone))
}
