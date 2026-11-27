//! Cấu hình trang bán hàng (`settings.online_store`, JSON) và 2 route quản trị `GET`/`PUT /store/settings`
//! (`store.service.ts`: `cleanStoreSettings`, `settings`, `saveSettings`). Tính năng tổ chức `online_store` (mặc định tắt) do tầng
//! route kiểm (`RouteSpec::org_feature`).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::PgConnection;
use trinity_db::CompanyRef;
use trinity_db::platform::{Platform, PlatformError, RouteKind};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vi::trim_js;

use crate::db;
use crate::vietqr::{self, VIETQR_BANKS};

pub const STORE_SETTING_KEY: &str = "online_store";
pub const STORE_THEMES: [&str; 3] = ["toi-gian", "am-ap", "soi-dong"];
const RESERVED: [&str; 8] = ["admin", "api", "www", "app", "login", "settings", "static", "trinity"];

/// Cấu hình cửa hàng. Thứ tự trường như `DEFAULTS` của bản TS (thứ tự khoá JSON lưu trong DB).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StoreSettings {
    pub slug: String,
    pub name: String,
    pub tagline: Option<String>,
    pub theme: String,
    pub accent: String,
    pub phone: Option<String>,
    pub address: Option<String>,
    /// Ảnh bìa + logo (https), hiện ở đầu trang.
    pub cover_url: Option<String>,
    pub logo_url: Option<String>,
    pub cod: bool,
    pub bank_transfer: bool,
    /// Tài khoản nhận chuyển khoản (QR VietQR tự sinh): BIN ngân hàng 6 số, số tài khoản, tên chủ tài khoản (hiển thị).
    pub bank_bin: Option<String>,
    pub bank_account: Option<String>,
    pub bank_account_name: Option<String>,
    /// Nhắc chủ cửa hàng (vd migration 0022 tắt chuyển khoản vì không đọc được tài khoản SePay cũ); lưu tài khoản hợp lệ thì xoá.
    pub bank_notice: Option<String>,
    pub published: bool,
    pub product_ids: Vec<i64>,
    /// Người phụ trách khách mới tạo từ đơn online.
    pub owner_user_id: Option<i32>,
    /// Khoá lạ trong JSON đã lưu (bản TS giữ nguyên khi lưu lại, ta cũng vậy).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for StoreSettings {
    fn default() -> Self {
        Self {
            slug: String::new(),
            name: String::new(),
            tagline: None,
            theme: "toi-gian".to_owned(),
            accent: "#2563eb".to_owned(),
            phone: None,
            address: None,
            cover_url: None,
            logo_url: None,
            cod: true,
            bank_transfer: false,
            bank_bin: None,
            bank_account: None,
            bank_account_name: None,
            bank_notice: None,
            published: false,
            product_ids: Vec::new(),
            owner_user_id: None,
            extra: Map::new(),
        }
    }
}

/// Ngân hàng cho màn cấu hình (BIN + tên).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BankOption {
    pub bin: &'static str,
    pub name: &'static str,
}

pub fn store_banks() -> Vec<BankOption> {
    VIETQR_BANKS
        .iter()
        .map(|b| BankOption {
            bin: b.bin,
            name: b.name,
        })
        .collect()
}

/// Phản hồi `GET`/`PUT /store/settings` (`withPublicPath`): cấu hình + `public_path` + `banks`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SettingsView {
    #[serde(flatten)]
    pub settings: StoreSettings,
    pub public_path: Option<String>,
    pub banks: Vec<BankOption>,
}

/// Đường dẫn trang công khai, kèm `?cid=` khi bản nhiều công ty và không phải công ty 1 (web ghép origin vào trước).
pub fn public_path(slug: &str, multi_tenant: bool, company_id: i32) -> Option<String> {
    if slug.is_empty() {
        return None;
    }
    let p = format!("/s/{slug}");
    Some(if multi_tenant && company_id != 1 {
        format!("{p}?cid={company_id}")
    } else {
        p
    })
}

pub fn view(s: StoreSettings, multi_tenant: bool, company_id: i32) -> SettingsView {
    let public_path = public_path(&s.slug, multi_tenant, company_id);
    SettingsView {
        settings: s,
        public_path,
        banks: store_banks(),
    }
}

/// Tài khoản nhận chuyển khoản đang dùng được (bật + đủ BIN hợp lệ + số TK), không thì `None`.
pub struct BankAccount {
    pub bin: &'static str,
    pub name: &'static str,
    pub account: String,
    pub account_name: Option<String>,
}

pub fn bank_account_of(s: &StoreSettings) -> Option<BankAccount> {
    let account = s
        .bank_account
        .as_deref()
        .filter(|a| s.bank_transfer && vietqr::is_valid_account(a))?;
    let bank = vietqr::find_bank(s.bank_bin.as_deref().unwrap_or(""))?;
    Some(BankAccount {
        bin: bank.bin,
        name: bank.name,
        account: account.to_owned(),
        account_name: s.bank_account_name.clone(),
    })
}

fn bad(msg: &str) -> AppError {
    HttpError::bad_request(msg).into()
}

/// `String(v ?? '')` của JS cho giá trị JSON.
pub(crate) fn js_str(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(a) => a.iter().map(js_str).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `Number(v)` của JS: `None` khi ra NaN.
pub(crate) fn js_num(v: &Value) -> Option<f64> {
    match v {
        Value::Null => Some(0.0),
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        Value::String(s) => {
            let t = trim_js(s);
            if t.is_empty() {
                Some(0.0)
            } else {
                t.parse::<f64>().ok().filter(|f| f.is_finite())
            }
        }
        _ => None,
    }
}

/// Cắt theo đơn vị UTF-16 như `String.prototype.slice(0, max)`.
pub(crate) fn slice16(s: &str, max: usize) -> String {
    let mut n = 0;
    let mut out = String::new();
    for c in s.chars() {
        n += c.len_utf16();
        if n > max {
            break;
        }
        out.push(c);
    }
    out
}

fn text(input: &Map<String, Value>, k: &str, max: usize) -> Option<String> {
    input.get(k).map(|v| slice16(trim_js(&js_str(v)), max))
}

fn valid_slug(s: &str) -> bool {
    let b = s.as_bytes();
    (3..=40).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b[b.len() - 1].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && !RESERVED.contains(&s)
}

fn valid_https(s: &str) -> bool {
    // `get(..8)` (không cắt theo byte): ký tự nhiều byte ở đầu chuỗi không làm panic.
    s.get(..8).is_some_and(|p| p.eq_ignore_ascii_case("https://"))
        && s.get(8..).is_some_and(|rest| {
            !rest.is_empty()
                && rest
                    .chars()
                    .all(|c| !c.is_whitespace() && !matches!(c, '"' | '\'' | '<' | '>'))
        })
}

fn valid_accent(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// `cleanStoreSettings`: áp `input` (PUT một phần) lên `current`, kiểm từng trường như bản TS.
pub fn clean(input: &Map<String, Value>, current: &StoreSettings) -> Result<StoreSettings, AppError> {
    let mut next = current.clone();
    if let Some(slug) = text(input, "slug", 40) {
        let s = slug.to_lowercase();
        if !valid_slug(&s) {
            return Err(bad(
                "Địa chỉ trang: 3–40 ký tự chữ thường không dấu, số, gạch ngang (vd cua-hang-abc).",
            ));
        }
        next.slug = s;
    }
    if let Some(name) = text(input, "name", 80) {
        if name.is_empty() {
            return Err(bad("Thiếu tên cửa hàng."));
        }
        next.name = name;
    }
    for (k, max) in [("tagline", 120), ("phone", 120), ("address", 200)] {
        if let Some(v) = text(input, k, max) {
            let v = (!v.is_empty()).then_some(v);
            match k {
                "tagline" => next.tagline = v,
                "phone" => next.phone = v,
                _ => next.address = v,
            }
        }
    }
    for k in ["cover_url", "logo_url"] {
        let Some(v) = text(input, k, 500) else { continue };
        if !v.is_empty() && !valid_https(&v) {
            return Err(bad("Ảnh bìa / logo phải là đường dẫn https."));
        }
        let v = (!v.is_empty()).then_some(v);
        if k == "cover_url" {
            next.cover_url = v
        } else {
            next.logo_url = v
        }
    }
    if let Some(theme) = input.get("theme") {
        let t = match js_str(theme).as_str() {
            "dam-net" => "soi-dong".to_owned(), // tên cũ
            other => other.to_owned(),
        };
        // `undefined` bỏ qua; `null` thành chuỗi "null" nên không hợp lệ (như `String(null)`).
        if !STORE_THEMES.contains(&t.as_str()) {
            return Err(bad("Giao diện không hợp lệ."));
        }
        next.theme = t;
    }
    if let Some(a) = input.get("accent") {
        let a = js_str(a);
        if !valid_accent(&a) {
            return Err(bad("Màu chủ đạo dạng #RRGGBB."));
        }
        next.accent = a;
    }
    for k in ["cod", "bank_transfer", "published"] {
        if let Some(Value::Bool(b)) = input.get(k) {
            match k {
                "cod" => next.cod = *b,
                "bank_transfer" => next.bank_transfer = *b,
                _ => next.published = *b,
            }
        }
    }
    if let Some(v) = input.get("bank_bin") {
        let raw = js_str(v);
        let raw = trim_js(&raw);
        let bank = if raw.is_empty() { None } else { vietqr::find_bank(raw) };
        if !raw.is_empty() && bank.is_none() {
            return Err(bad(
                "Ngân hàng không có trong danh sách nhận VietQR — chọn lại ngân hàng.",
            ));
        }
        next.bank_bin = bank.map(|b| b.bin.to_owned());
    }
    if let Some(v) = input.get("bank_account") {
        let acc: String = js_str(v).split_whitespace().collect();
        if !acc.is_empty() && !vietqr::is_valid_account(&acc) {
            return Err(bad("Số tài khoản: 4–19 chữ số hoặc chữ cái, không dấu cách."));
        }
        next.bank_account = (!acc.is_empty()).then_some(acc);
    }
    if let Some(n) = text(input, "bank_account_name", 80) {
        next.bank_account_name = (!n.is_empty()).then_some(n);
    }
    // Chỉ bắt buộc tài khoản khi lần lưu này BẬT chuyển khoản hoặc sửa trường ngân hàng: lưu trường khác (tên, sản phẩm…) trên cấu
    // hình cũ thiếu tài khoản vẫn được — trang công khai tự coi như chưa nhận chuyển khoản (`bank_account_of`).
    let touches_bank = input.get("bank_transfer") == Some(&Value::Bool(true))
        || ["bank_bin", "bank_account", "bank_account_name"]
            .iter()
            .any(|k| input.contains_key(*k));
    if next.bank_transfer && touches_bank && !(next.bank_bin.is_some() && next.bank_account.is_some()) {
        return Err(bad("Chuyển khoản cần chọn ngân hàng và nhập số tài khoản nhận tiền."));
    }
    // Nhắc chỉ xoá khi đã có tài khoản nhận tiền DÙNG ĐƯỢC (ngân hàng trong bảng + số tài khoản hợp lệ).
    let usable = next.bank_bin.as_deref().is_some_and(|b| vietqr::find_bank(b).is_some())
        && next.bank_account.as_deref().is_some_and(vietqr::is_valid_account);
    if usable {
        next.bank_notice = None;
    }
    if let Some(Value::Array(a)) = input.get("product_ids") {
        let mut ids: Vec<i64> = Vec::new();
        for v in a {
            if let Some(n) = js_num(v).filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0) {
                #[allow(clippy::cast_possible_truncation)]
                let n = n as i64;
                if !ids.contains(&n) {
                    ids.push(n);
                }
            }
        }
        if ids.len() > 200 {
            return Err(bad("Tối đa 200 sản phẩm trên trang."));
        }
        next.product_ids = ids;
    }
    if let Some(v) = input.get("owner_user_id") {
        next.owner_user_id = if v.is_null() {
            None
        } else {
            js_num(v)
                .filter(|n| *n != 0.0 && n.fract() == 0.0 && n.abs() < 2_147_483_648.0)
                .map(|n| {
                    #[allow(clippy::cast_possible_truncation)]
                    let n = n as i32;
                    n
                })
        };
    }
    if next.published {
        if next.slug.is_empty() || next.name.is_empty() {
            return Err(bad("Cần địa chỉ trang và tên cửa hàng trước khi mở bán."));
        }
        if !next.cod && !next.bank_transfer {
            return Err(bad("Bật ít nhất một cách thanh toán (COD hoặc chuyển khoản)."));
        }
    }
    Ok(next)
}

/// `GET /store/settings` (phần cấu hình): dòng vắng hoặc JSON rác ⇒ mặc định.
pub async fn load(conn: &mut PgConnection) -> Result<StoreSettings, AppError> {
    let row: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(STORE_SETTING_KEY)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    let Some(row) = row else {
        return Ok(StoreSettings::default());
    };
    Ok(from_stored(&row))
}

/// Gộp từng trường của JSON đã lưu lên mặc định như `{ ...DEFAULTS, ...parsed }` của TS: một trường sai kiểu chỉ rơi về mặc định
/// của riêng nó (không reset cả cấu hình); khoá lạ được giữ. JSON rác (không phải object) ⇒ mặc định.
pub fn from_stored(raw: &str) -> StoreSettings {
    let Ok(Value::Object(m)) = serde_json::from_str::<Value>(raw) else {
        return StoreSettings::default();
    };
    fn pick<T: serde::de::DeserializeOwned>(m: &Map<String, Value>, k: &str, d: T) -> T {
        m.get(k)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or(d)
    }
    const KNOWN: [&str; 18] = [
        "slug",
        "name",
        "tagline",
        "theme",
        "accent",
        "phone",
        "address",
        "cover_url",
        "logo_url",
        "cod",
        "bank_transfer",
        "bank_bin",
        "bank_account",
        "bank_account_name",
        "bank_notice",
        "published",
        "product_ids",
        "owner_user_id",
    ];
    let d = StoreSettings::default();
    let mut v = StoreSettings {
        slug: pick(&m, "slug", d.slug),
        name: pick(&m, "name", d.name),
        tagline: pick(&m, "tagline", d.tagline),
        theme: pick(&m, "theme", d.theme),
        accent: pick(&m, "accent", d.accent),
        phone: pick(&m, "phone", d.phone),
        address: pick(&m, "address", d.address),
        cover_url: pick(&m, "cover_url", d.cover_url),
        logo_url: pick(&m, "logo_url", d.logo_url),
        cod: pick(&m, "cod", d.cod),
        bank_transfer: pick(&m, "bank_transfer", d.bank_transfer),
        bank_bin: pick(&m, "bank_bin", d.bank_bin),
        bank_account: pick(&m, "bank_account", d.bank_account),
        bank_account_name: pick(&m, "bank_account_name", d.bank_account_name),
        bank_notice: pick(&m, "bank_notice", d.bank_notice),
        published: pick(&m, "published", d.published),
        product_ids: pick(&m, "product_ids", d.product_ids),
        owner_user_id: pick(&m, "owner_user_id", d.owner_user_id),
        extra: m
            .iter()
            .filter(|(k, _)| !KNOWN.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    };
    if v.theme == "dam-net" {
        v.theme = "soi-dong".to_owned();
    }
    v
}

/// `PUT /store/settings`: `input` đã bỏ `public_path`, `banks`, `bank_notice` (không cho client ghi). Bản nhiều công ty: địa chỉ
/// (slug) thuộc MỘT công ty, ai đến trước giữ ([`Platform::claim_route`]); đổi slug thì nhả slug cũ.
pub async fn save(
    conn: &mut PgConnection,
    platform: &Platform,
    company: CompanyRef,
    input: &Map<String, Value>,
    user_id: i32,
) -> Result<StoreSettings, AppError> {
    let current = load(conn).await?;
    let base = StoreSettings {
        owner_user_id: current.owner_user_id.or(Some(user_id)),
        ..current.clone()
    };
    let mut input = input.clone();
    for k in ["public_path", "banks", "bank_notice"] {
        input.remove(k);
    }
    let next = clean(&input, &base)?;
    if !next.slug.is_empty() && next.slug != current.slug {
        platform
            .claim_route(RouteKind::StoreSlug, &next.slug, company)
            .await
            .map_err(|e| match e {
                PlatformError::Conflict(m) => HttpError::conflict(m).into(),
                other => AppError::internal(other),
            })?;
    }
    let value = serde_json::to_string(&next).map_err(AppError::internal)?;
    let saved = sqlx::query(
        "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()",
    )
    .bind(STORE_SETTING_KEY)
    .bind(&value)
    .bind(user_id)
    .execute(&mut *conn)
    .await;
    if let Err(e) = saved {
        // Ghi lỗi sau khi đã giữ địa chỉ mới: nhả lại để không để lại địa chỉ mồ côi chặn người khác.
        if !next.slug.is_empty()
            && next.slug != current.slug
            && let Err(r) = platform.release_route(RouteKind::StoreSlug, &next.slug, company).await
        {
            tracing::warn!("Không nhả được địa chỉ cửa hàng sau lỗi lưu: {r}");
        }
        return Err(db(e));
    }
    if !current.slug.is_empty() && current.slug != next.slug {
        platform
            .release_route(RouteKind::StoreSlug, &current.slug, company)
            .await
            .map_err(AppError::internal)?;
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(v: Value) -> Result<StoreSettings, String> {
        clean(v.as_object().unwrap(), &StoreSettings::default()).map_err(|e| e.to_string())
    }

    #[test]
    fn slug_ten_va_giao_dien() {
        let s = run(json!({ "slug": " Cua-Hang-ABC ", "name": " Shop ", "theme": "dam-net", "accent": "#12abEF" }))
            .unwrap();
        assert_eq!(
            (s.slug.as_str(), s.name.as_str(), s.theme.as_str(), s.accent.as_str()),
            ("cua-hang-abc", "Shop", "soi-dong", "#12abEF")
        );
        let long = "x".repeat(41);
        for bad in ["ab", "-abc", "abc-", "a b c", "admin", "Trinity", long.as_str()] {
            // 41 ký tự bị cắt về 40 nên hợp lệ; còn lại đều sai.
            let r = run(json!({ "slug": bad }));
            assert_eq!(r.is_err(), bad.len() != 41, "{bad}");
        }
        assert!(run(json!({ "name": "  " })).is_err());
        assert!(run(json!({ "theme": "la" })).is_err());
        assert!(run(json!({ "theme": null })).is_err());
        assert!(run(json!({ "accent": "red" })).is_err());
    }

    #[test]
    fn anh_va_ngan_hang() {
        assert!(run(json!({ "cover_url": "http://x.vn/a.png" })).is_err());
        assert_eq!(
            run(json!({ "cover_url": "https://x.vn/a.png", "logo_url": "" }))
                .unwrap()
                .logo_url,
            None
        );
        let s = run(json!({ "bank_transfer": true, "bank_bin": "MBBank", "bank_account": " 0123 4567 89 " })).unwrap();
        assert_eq!(
            (s.bank_bin.as_deref(), s.bank_account.as_deref()),
            (Some("970422"), Some("0123456789"))
        );
        assert!(run(json!({ "bank_bin": "khong-co" })).is_err());
        assert!(run(json!({ "bank_account": "01-23" })).is_err());
        // Bật chuyển khoản mà thiếu tài khoản ⇒ lỗi; lưu trường khác trên cấu hình cũ thì không.
        assert!(run(json!({ "bank_transfer": true })).is_err());
        let old = StoreSettings {
            bank_transfer: true,
            ..StoreSettings::default()
        };
        assert!(clean(json!({ "name": "A" }).as_object().unwrap(), &old).is_ok());
        // Lưu tài khoản hợp lệ thì xoá nhắc.
        let with = StoreSettings {
            bank_transfer: true,
            bank_notice: Some("x".into()),
            ..StoreSettings::default()
        };
        let s = clean(
            json!({ "bank_bin": "970422", "bank_account": "0123456789" })
                .as_object()
                .unwrap(),
            &with,
        )
        .unwrap();
        assert_eq!(s.bank_notice, None);
    }

    #[test]
    fn san_pham_chu_so_huu_va_mo_ban() {
        let s = run(json!({ "product_ids": [3, "4", 3, -1, 0, 1.5, "x", true] })).unwrap();
        assert_eq!(s.product_ids, vec![3, 4, 1]);
        assert!(run(json!({ "product_ids": (1..=201).collect::<Vec<_>>() })).is_err());
        assert_eq!(run(json!({ "owner_user_id": null })).unwrap().owner_user_id, None);
        assert_eq!(run(json!({ "owner_user_id": "7" })).unwrap().owner_user_id, Some(7));
        assert!(run(json!({ "published": true })).is_err());
        assert!(run(json!({ "published": true, "slug": "abc", "name": "A", "cod": false })).is_err());
        assert!(run(json!({ "published": true, "slug": "abc", "name": "A" })).is_ok());
    }

    #[test]
    fn gop_tung_truong_va_giu_khoa_la() {
        let s = from_stored(r#"{"name":"A","cod":"co","theme":"dam-net","product_ids":[1,2],"zzz":{"k":1}}"#);
        assert_eq!(
            (s.name.as_str(), s.cod, s.theme.as_str(), s.product_ids.clone()),
            ("A", true, "soi-dong", vec![1, 2])
        );
        assert_eq!(s.extra.get("zzz"), Some(&json!({ "k": 1 })));
        assert_eq!(from_stored("rac"), StoreSettings::default());
        // Giữ khoá lạ khi lưu lại.
        assert!(serde_json::to_string(&s).unwrap().contains("\"zzz\""));
    }

    #[test]
    fn https_khong_panic_voi_ky_tu_nhieu_byte() {
        assert!(!valid_https("ééééé"));
        assert!(!valid_https("https://"));
        assert!(!valid_https("httpsé://x"));
        assert!(valid_https("HTTPS://x.vn/a.png"));
    }

    #[test]
    fn nhac_chi_xoa_khi_co_tai_khoan_dung_duoc() {
        let with = StoreSettings {
            bank_transfer: false,
            bank_notice: Some("x".into()),
            ..StoreSettings::default()
        };
        let s = clean(json!({ "name": "A" }).as_object().unwrap(), &with).unwrap();
        assert_eq!(s.bank_notice.as_deref(), Some("x"));
        let s = clean(
            json!({ "bank_bin": "970422", "bank_account": "0123456789" })
                .as_object()
                .unwrap(),
            &with,
        )
        .unwrap();
        assert_eq!(s.bank_notice, None);
    }

    #[test]
    fn duong_dan_cong_khai() {
        assert_eq!(public_path("", true, 2), None);
        assert_eq!(public_path("shop", false, 2).as_deref(), Some("/s/shop"));
        assert_eq!(public_path("shop", true, 1).as_deref(), Some("/s/shop"));
        assert_eq!(public_path("shop", true, 2).as_deref(), Some("/s/shop?cid=2"));
    }
}
