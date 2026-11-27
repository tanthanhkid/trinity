//! Webhook Meta (M47a), chuyển từ `facebook-public.controller.ts` (`verify`, `receive`), `facebook-webhook.service.ts` và
//! `facebook-signature.ts`: GET xác minh (`hub.verify_token`) + POST sự kiện (chữ ký `X-Hub-Signature-256` bằng app secret).
//! Phải trả 200 trong ≤ 5 giây và Meta gửi lại khi lỗi, nên mọi bước xử lý phải idempotent (M47b khử trùng theo `mid`,
//! `comment_id`, `leadgen_id`).
//!
//! Luồng [`Receiver::receive`]:
//! 1. thiếu app secret ⇒ 503; chữ ký không khớp ⇒ 401 `Chữ ký không hợp lệ` (tính trên BYTE THÔ, không dựng lại JSON);
//! 2. một công ty: lô có Page KHÔNG nối vào bản này ⇒ chuyển tiếp nguyên văn (thân thô + chữ ký gốc) sang
//!    `FACEBOOK_WEBHOOK_FORWARD_URL` rồi xử lý cả lô cho công ty 1;
//! 3. nhiều công ty: nhóm entry theo công ty sở hữu Page (`platform.company_routes`), Page chưa công ty nào nối thì BỎ QUA (không
//!    rơi về công ty 1) và chuyển tiếp cả lô; mỗi nhóm chạy dưới đúng công ty;
//! 4. lô đã mang header `x-trinity-forwarded` thì KHÔNG chuyển tiếp nữa (chống vòng lặp giữa hai bản);
//! 5. cờ tính năng `facebook_page` tắt ⇒ bỏ qua (vẫn 200 để Meta không tắt webhook).
//!
//! Việc xử lý từng loại sự kiện (tin nhắn, referral, leadgen, bình luận) đi qua [`EntryProcessor`]: M47b/M49 cài; ở đây chỉ
//! giao các entry của đúng công ty. Lỗi tạm của processor được ném ra ⇒ route trả 5xx ⇒ Meta gửi lại.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use hmac::{Hmac, KeyInit, Mac};
use regex::Regex;
use serde_json::Value;
use sha2::Sha256;
use subtle::ConstantTimeEq;
use trinity_db::platform::{Platform, RouteKind};
use trinity_db::{CompanyRef, Db};
use trinity_http::router::OrgFeatureGate;
use trinity_kernel::error::{AppError, HttpError};

use crate::config::{Env, FORWARDED_HEADER, load_facebook_config, webhook_forward_url};

type Hmac256 = Hmac<Sha256>;
pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Thời gian chờ tối đa khi chuyển tiếp (không chờ kết quả ở luồng chính).
pub const FORWARD_TIMEOUT: Duration = Duration::from_secs(8);

// ───────────────────────────── chữ ký ─────────────────────────────

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

fn hmac_hex(raw: &[u8], secret: &str) -> String {
    #[allow(clippy::expect_used)]
    let mut mac = Hmac256::new_from_slice(secret.as_bytes()).expect("HMAC nhận khoá mọi độ dài");
    mac.update(raw);
    hex(&mac.finalize().into_bytes())
}

/// `sha256=` + HMAC-SHA256(thân thô, app secret) hex thường (`signMetaBody`).
pub fn sign_meta_body(raw: &[u8], secret: &str) -> String {
    format!("sha256={}", hmac_hex(raw, secret))
}

#[allow(clippy::expect_used)]
fn signature_re() -> &'static Regex {
    static RE: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"(?i)^sha256=([0-9a-f]{64})$").expect("regex chữ ký"));
    &RE
}

/// Kiểm `X-Hub-Signature-256`. Tính trên BYTE THÔ của body. Thiếu secret/thân/header hoặc sai định dạng ⇒ `false`; hex viết hoa
/// được chấp nhận (so sau khi hạ chữ thường); so hằng thời gian.
pub fn verify_meta_signature(raw: Option<&[u8]>, header: Option<&str>, secret: &str) -> bool {
    let (Some(raw), Some(header)) = (raw, header) else {
        return false;
    };
    if secret.is_empty() {
        return false;
    }
    let Some(m) = signature_re().captures(js_trim(header)) else {
        return false;
    };
    let got = m[1].to_ascii_lowercase();
    let want = hmac_hex(raw, secret);
    got.len() == want.len() && got.as_bytes().ct_eq(want.as_bytes()).unwrap_u8() == 1
}

/// `String.prototype.trim` cho giá trị header.
fn js_trim(s: &str) -> &str {
    trinity_kernel::vi::trim_js(s)
}

/// `safeEqual`: so chuỗi hằng thời gian (độ dài khác ⇒ sai).
fn safe_equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.as_bytes().ct_eq(b.as_bytes()).unwrap_u8() == 1
}

// ───────────────────────────── xác minh (GET) ─────────────────────────────

/// `GET /facebook/webhook`: bước xác minh khi khai webhook trong App Dashboard; trả nguyên `hub.challenge`. Sai/thiếu bất kỳ
/// phần nào, hoặc chưa đặt verify token ⇒ 403 trơn (`Forbidden`).
pub fn verify(env: &Env, mode: Option<&str>, token: Option<&str>, challenge: Option<&str>) -> Result<String, AppError> {
    let expected = load_facebook_config(env).verify_token;
    match (mode, token, challenge) {
        (Some("subscribe"), Some(t), Some(c))
            if !expected.is_empty() && !t.is_empty() && !c.is_empty() && safe_equal(t, &expected) =>
        {
            Ok(c.to_owned())
        }
        _ => Err(HttpError::nest(403, None).into()),
    }
}

// ───────────────────────────── cổng ra: tuyến, chuyển tiếp, xử lý ─────────────────────────────

/// Tra công ty sở hữu Page và Page đã nối của bản này.
pub trait PageRouter: Send + Sync {
    /// Nhiều công ty? Một công ty thì mọi Page thuộc công ty 1 và lô lạ được chuyển tiếp theo bảng `facebook_pages`.
    fn multi_tenant(&self) -> bool;
    /// Công ty ĐANG HOẠT ĐỘNG sở hữu Page (`platform.company_routes`); chưa nối hoặc công ty bị treo ⇒ `None`.
    fn company_for_page<'a>(&'a self, page_id: &'a str) -> BoxFut<'a, Result<Option<CompanyRef>, AppError>>;
    /// Trong `ids`, Page nào đã nối ở công ty mặc định (chế độ một công ty).
    fn known_pages<'a>(&'a self, ids: &'a [String]) -> BoxFut<'a, Result<HashSet<String>, AppError>>;
}

/// Chuyển tiếp nguyên văn thân + chữ ký (không chờ).
pub trait Forwarder: Send + Sync {
    fn forward(&self, url: &str, raw: &[u8], signature: &str);
}

/// Xử lý các entry của MỘT công ty (ngữ cảnh công ty đã chọn): tin nhắn, referral, bình luận, leadgen. Trả số sự kiện đã xử lý.
pub trait EntryProcessor: Send + Sync {
    fn process<'a>(&'a self, company: CompanyRef, entries: &'a [Value]) -> BoxFut<'a, Result<usize, AppError>>;
}

/// Bản dựng dùng `Platform` + `Db` thật.
pub struct PlatformRouter {
    pub db: Db,
    pub platform: Platform,
}

fn internal(e: impl std::error::Error + Send + Sync + 'static) -> AppError {
    AppError::internal(e)
}

impl PageRouter for PlatformRouter {
    fn multi_tenant(&self) -> bool {
        self.platform.multi_tenant()
    }

    fn company_for_page<'a>(&'a self, page_id: &'a str) -> BoxFut<'a, Result<Option<CompanyRef>, AppError>> {
        Box::pin(async move {
            let Some(id) = self
                .platform
                .company_for_route(RouteKind::FacebookPage, page_id)
                .await
                .map_err(internal)?
            else {
                return Ok(None);
            };
            self.platform.active_company(i64::from(id)).await.map_err(internal)
        })
    }

    fn known_pages<'a>(&'a self, ids: &'a [String]) -> BoxFut<'a, Result<HashSet<String>, AppError>> {
        Box::pin(async move {
            let tenant = self.db.tenant(CompanyRef::DEFAULT).await.map_err(internal)?;
            let mut conn = tenant.acquire().await.map_err(internal)?;
            let rows: Vec<String> = sqlx::query_scalar("SELECT page_id FROM facebook_pages WHERE page_id = ANY($1)")
                .bind(ids)
                .fetch_all(&mut *conn)
                .await
                .map_err(internal)?;
            Ok(rows.into_iter().collect())
        })
    }
}

/// Chuyển tiếp bằng `reqwest`, chạy nền, timeout 8 giây; lỗi chỉ ghi log (không làm hỏng lô đang xử lý).
pub struct HttpForwarder {
    pub http: reqwest::Client,
}

impl Forwarder for HttpForwarder {
    fn forward(&self, url: &str, raw: &[u8], signature: &str) {
        let (http, url, body, sig) = (self.http.clone(), url.to_owned(), raw.to_vec(), signature.to_owned());
        tokio::spawn(async move {
            let res = http
                .post(&url)
                .header("content-type", "application/json")
                .header("x-hub-signature-256", sig)
                .header(FORWARDED_HEADER, "1")
                .timeout(FORWARD_TIMEOUT)
                .body(body)
                .send()
                .await;
            match res {
                Ok(r) if !r.status().is_success() => {
                    tracing::warn!("Chuyển tiếp webhook Facebook: bản kia trả {}", r.status().as_u16())
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("Chuyển tiếp webhook Facebook lỗi: {e}"),
            }
        });
    }
}

// ───────────────────────────── nhận sự kiện (POST) ─────────────────────────────

/// Id của một entry: chuỗi không rỗng (số cũng nhận, như id Page do Meta gửi); khác ⇒ bỏ qua entry.
fn entry_id(entry: &Value) -> Option<String> {
    match entry.get("id")? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Lô hợp lệ: `object == "page"` và `entry` là mảng.
fn page_entries(body: &Value) -> Option<&Vec<Value>> {
    if body.get("object").and_then(Value::as_str) != Some("page") {
        return None;
    }
    body.get("entry").and_then(Value::as_array)
}

/// Kết quả nhóm entry theo công ty (giữ thứ tự entry trong từng nhóm và thứ tự công ty xuất hiện).
#[derive(Debug, Default)]
pub struct Groups {
    pub by_company: Vec<(CompanyRef, Vec<Value>)>,
    /// Số entry của Page chưa công ty nào nối (hoặc công ty bị treo).
    pub unknown: usize,
}

pub struct Receiver {
    pub env: Env,
    pub router: Arc<dyn PageRouter>,
    pub features: Arc<dyn OrgFeatureGate>,
    pub processor: Arc<dyn EntryProcessor>,
    pub forwarder: Arc<dyn Forwarder>,
}

impl Receiver {
    /// Nhóm entry theo công ty sở hữu Page. Mỗi Page chỉ tra một lần trong một lô.
    pub async fn group_by_company(&self, entries: &[Value]) -> Result<Groups, AppError> {
        let mut owner: HashMap<String, Option<CompanyRef>> = HashMap::new();
        let mut g = Groups::default();
        for entry in entries {
            let Some(id) = entry_id(entry) else { continue };
            if !owner.contains_key(&id) {
                let c = self.router.company_for_page(&id).await?;
                owner.insert(id.clone(), c);
            }
            let Some(company) = owner[&id] else {
                g.unknown += 1;
                continue;
            };
            match g.by_company.iter_mut().find(|(c, _)| c.id() == company.id()) {
                Some((_, v)) => v.push(entry.clone()),
                None => g.by_company.push((company, vec![entry.clone()])),
            }
        }
        Ok(g)
    }

    /// `POST /facebook/webhook`: trả số sự kiện đã xử lý. `raw` là thân thô đã nhận, `body` là JSON đã parse từ đó,
    /// `forwarded` = lô đã mang header chuyển tiếp.
    pub async fn receive(
        &self,
        raw: Option<&[u8]>,
        signature: Option<&str>,
        body: &Value,
        forwarded: bool,
    ) -> Result<usize, AppError> {
        let secret = load_facebook_config(&self.env).app_secret;
        if secret.is_empty() {
            return Err(HttpError::nest(503, None).into());
        }
        if !verify_meta_signature(raw, signature, &secret) {
            return Err(HttpError::unauthorized("Chữ ký không hợp lệ").into());
        }
        let (raw, signature) = (raw.unwrap_or_default(), signature.unwrap_or_default());
        let entries = page_entries(body).cloned().unwrap_or_default();
        if !self.router.multi_tenant() {
            if !forwarded {
                self.forward_foreign_pages(raw, signature, &entries).await;
            }
            return self.process_entries(CompanyRef::DEFAULT, &entries).await;
        }
        // Nhiều công ty: một POST có thể gồm entry của nhiều Page thuộc nhiều công ty ⇒ chạy từng nhóm dưới công ty sở hữu Page.
        let groups = self.group_by_company(&entries).await?;
        if !forwarded && groups.unknown > 0 {
            self.forward(raw, signature);
        }
        let mut n = 0;
        for (company, es) in &groups.by_company {
            n += self.process_entries(*company, es).await?;
        }
        Ok(n)
    }

    /// Cờ gói `facebook_page` tắt ⇒ bỏ qua (0); không có entry ⇒ 0.
    async fn process_entries(&self, company: CompanyRef, entries: &[Value]) -> Result<usize, AppError> {
        if !self.features.enabled(company, "facebook_page").await || entries.is_empty() {
            return Ok(0);
        }
        self.processor.process(company, entries).await
    }

    /// Chế độ một công ty: lô có Page KHÔNG nối vào bản này ⇒ chuyển tiếp nguyên văn. Lỗi tra Page ⇒ không chuyển (ghi log).
    async fn forward_foreign_pages(&self, raw: &[u8], signature: &str, entries: &[Value]) -> bool {
        if webhook_forward_url(&self.env).is_none() {
            return false;
        }
        let mut ids: Vec<String> = entries.iter().filter_map(entry_id).collect();
        ids.sort();
        ids.dedup();
        if ids.is_empty() {
            return false;
        }
        let known = match self.router.known_pages(&ids).await {
            Ok(k) => k,
            Err(e) => {
                tracing::error!("Tra Page để chuyển tiếp webhook lỗi: {e}");
                return false;
            }
        };
        if ids.iter().all(|i| known.contains(i)) {
            return false;
        }
        self.forward(raw, signature);
        true
    }

    fn forward(&self, raw: &[u8], signature: &str) {
        if let Some(url) = webhook_forward_url(&self.env) {
            self.forwarder.forward(&url, raw, signature);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    const SECRET: &str = "contract-fb-app-secret-0123456789";

    fn env(pairs: &[(&str, &str)]) -> Env {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        Arc::new(move |k| m.get(k).cloned())
    }

    #[test]
    fn chu_ky_tren_byte_tho() {
        let raw = br#"{"object":"page","entry":[]}"#;
        let sig = sign_meta_body(raw, SECRET);
        assert!(verify_meta_signature(Some(raw), Some(&sig), SECRET));
        // Hex viết hoa được chấp nhận; thân khác byte (thêm khoảng trắng) hoặc sai bí mật thì không.
        let upper = format!("sha256={}", sig[7..].to_uppercase());
        assert!(verify_meta_signature(Some(raw), Some(&upper), SECRET));
        assert!(verify_meta_signature(Some(raw), Some(&format!("  {sig}  ")), SECRET));
        assert!(!verify_meta_signature(
            Some(b"{\"object\":\"page\",\"entry\":[]} "),
            Some(&sig),
            SECRET
        ));
        assert!(!verify_meta_signature(Some(raw), Some(&sig), "bi-mat-khac"));
    }

    #[test]
    fn chu_ky_thieu_hoac_sai_dinh_dang_deu_tu_choi() {
        let raw = b"{}";
        let good = sign_meta_body(raw, SECRET);
        assert!(!verify_meta_signature(None, Some(&good), SECRET));
        assert!(!verify_meta_signature(Some(raw), None, SECRET));
        assert!(!verify_meta_signature(Some(raw), Some(&good), ""));
        for bad in [
            "abc",
            &good[7..],
            &format!("sha256={}", "0".repeat(63)),
            &format!("sha256={}", "g".repeat(64)),
            &format!("{good}0"),
        ] {
            assert!(!verify_meta_signature(Some(raw), Some(bad), SECRET), "{bad}");
        }
    }

    #[test]
    fn xac_minh_get() {
        let e = env(&[("FACEBOOK_WEBHOOK_VERIFY_TOKEN", "tok")]);
        assert_eq!(
            verify(&e, Some("subscribe"), Some("tok"), Some("thu-thach")).unwrap(),
            "thu-thach"
        );
        for (m, t, c) in [
            (Some("subscribe"), Some("sai"), Some("c")),
            (Some("unsubscribe"), Some("tok"), Some("c")),
            (Some("subscribe"), Some("tok"), None),
            (Some("subscribe"), None, Some("c")),
            (None, Some("tok"), Some("c")),
        ] {
            let err = verify(&e, m, t, c).unwrap_err();
            assert_eq!(err.response(true).0, 403);
        }
        // Chưa đặt verify token ⇒ luôn từ chối, kể cả khi người gọi gửi token rỗng.
        assert!(verify(&env(&[]), Some("subscribe"), Some(""), Some("c")).is_err());
    }

    #[test]
    fn id_entry_va_lo_hop_le() {
        assert_eq!(entry_id(&json!({ "id": "123" })).as_deref(), Some("123"));
        assert_eq!(entry_id(&json!({ "id": 123 })).as_deref(), Some("123"));
        assert_eq!(entry_id(&json!({ "id": "" })), None);
        assert_eq!(entry_id(&json!({})), None);
        assert!(page_entries(&json!({ "object": "page", "entry": [] })).is_some());
        assert!(page_entries(&json!({ "object": "instagram", "entry": [] })).is_none());
        assert!(page_entries(&json!({ "object": "page", "entry": "x" })).is_none());
    }

    // ── Receiver với cổng giả ──

    struct FakeRouter {
        multi: bool,
        owners: HashMap<String, CompanyRef>,
    }
    impl PageRouter for FakeRouter {
        fn multi_tenant(&self) -> bool {
            self.multi
        }
        fn company_for_page<'a>(&'a self, page_id: &'a str) -> BoxFut<'a, Result<Option<CompanyRef>, AppError>> {
            Box::pin(async move { Ok(self.owners.get(page_id).copied()) })
        }
        fn known_pages<'a>(&'a self, ids: &'a [String]) -> BoxFut<'a, Result<HashSet<String>, AppError>> {
            Box::pin(async move { Ok(ids.iter().filter(|i| self.owners.contains_key(*i)).cloned().collect()) })
        }
    }
    struct Gate(bool);
    impl OrgFeatureGate for Gate {
        fn enabled<'a>(&'a self, _c: CompanyRef, _f: &'a str) -> trinity_http::router::FeatureFuture<'a> {
            Box::pin(async move { self.0 })
        }
    }
    #[derive(Default)]
    struct Spy {
        processed: Mutex<Vec<(i32, Vec<String>)>>,
        forwarded: Mutex<Vec<(String, Vec<u8>, String)>>,
    }
    struct SpyProcessor(Arc<Spy>);
    impl EntryProcessor for SpyProcessor {
        fn process<'a>(&'a self, company: CompanyRef, entries: &'a [Value]) -> BoxFut<'a, Result<usize, AppError>> {
            Box::pin(async move {
                let ids = entries.iter().filter_map(entry_id).collect();
                self.0.processed.lock().unwrap().push((company.id(), ids));
                Ok(entries.len())
            })
        }
    }
    struct SpyForwarder(Arc<Spy>);
    impl Forwarder for SpyForwarder {
        fn forward(&self, url: &str, raw: &[u8], signature: &str) {
            self.0
                .forwarded
                .lock()
                .unwrap()
                .push((url.to_owned(), raw.to_vec(), signature.to_owned()));
        }
    }

    fn receiver(multi: bool, owners: &[(&str, CompanyRef)], gate: bool, forward: bool) -> (Receiver, Arc<Spy>) {
        let spy = Arc::new(Spy::default());
        let mut pairs = vec![("FACEBOOK_APP_SECRET", SECRET)];
        if forward {
            pairs.push((
                "FACEBOOK_WEBHOOK_FORWARD_URL",
                "https://ban-kia.example/api/v1/facebook/webhook",
            ));
        }
        let r = Receiver {
            env: env(&pairs),
            router: Arc::new(FakeRouter {
                multi,
                owners: owners.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect(),
            }),
            features: Arc::new(Gate(gate)),
            processor: Arc::new(SpyProcessor(spy.clone())),
            forwarder: Arc::new(SpyForwarder(spy.clone())),
        };
        (r, spy)
    }

    fn batch(ids: &[&str]) -> (Vec<u8>, Value) {
        let v = json!({ "object": "page", "entry": ids.iter().map(|i| json!({ "id": i, "messaging": [] })).collect::<Vec<_>>() });
        (serde_json::to_vec(&v).unwrap(), v)
    }

    #[tokio::test]
    async fn sai_chu_ky_401_va_thieu_secret_503() {
        let (r, spy) = receiver(true, &[("p1", CompanyRef::DEFAULT)], true, true);
        let (raw, body) = batch(&["p1"]);
        let e = r
            .receive(Some(&raw), Some("sha256=abc"), &body, false)
            .await
            .unwrap_err();
        assert_eq!(e.response(true).0, 401);
        assert!(spy.processed.lock().unwrap().is_empty() && spy.forwarded.lock().unwrap().is_empty());
        let (mut r2, _) = receiver(true, &[], true, false);
        r2.env = env(&[]);
        assert_eq!(
            r2.receive(Some(&raw), Some(&sign_meta_body(&raw, SECRET)), &body, false)
                .await
                .unwrap_err()
                .response(true)
                .0,
            503
        );
    }

    #[tokio::test]
    async fn nhieu_cong_ty_page_chua_noi_bi_bo_qua_va_chuyen_tiep_ca_lo() {
        let (r, spy) = receiver(true, &[("p1", CompanyRef::DEFAULT)], true, true);
        let (raw, body) = batch(&["p1", "la"]);
        let sig = sign_meta_body(&raw, SECRET);
        assert_eq!(r.receive(Some(&raw), Some(&sig), &body, false).await.unwrap(), 1);
        assert_eq!(*spy.processed.lock().unwrap(), vec![(1, vec!["p1".to_owned()])]);
        let f = spy.forwarded.lock().unwrap();
        assert_eq!(f.len(), 1);
        assert_eq!((&f[0].1, &f[0].2), (&raw, &sig), "nguyên byte và chữ ký gốc");
    }

    #[tokio::test]
    async fn da_chuyen_tiep_thi_khong_chuyen_lan_nua() {
        let (r, spy) = receiver(true, &[], true, true);
        let (raw, body) = batch(&["la"]);
        let sig = sign_meta_body(&raw, SECRET);
        assert_eq!(r.receive(Some(&raw), Some(&sig), &body, true).await.unwrap(), 0);
        assert!(spy.forwarded.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn page_da_noi_khong_chuyen_tiep_va_khong_dat_url_thi_khong_chuyen() {
        let (r, spy) = receiver(true, &[("p1", CompanyRef::DEFAULT)], true, true);
        let (raw, body) = batch(&["p1"]);
        r.receive(Some(&raw), Some(&sign_meta_body(&raw, SECRET)), &body, false)
            .await
            .unwrap();
        assert!(spy.forwarded.lock().unwrap().is_empty());
        let (r2, spy2) = receiver(true, &[], true, false);
        let (raw2, body2) = batch(&["la"]);
        r2.receive(Some(&raw2), Some(&sign_meta_body(&raw2, SECRET)), &body2, false)
            .await
            .unwrap();
        assert!(
            spy2.forwarded.lock().unwrap().is_empty(),
            "không có FACEBOOK_WEBHOOK_FORWARD_URL"
        );
    }

    #[tokio::test]
    async fn mot_cong_ty_lo_la_chuyen_tiep_va_van_xu_ly_cho_cong_ty_mot() {
        let (r, spy) = receiver(false, &[("p1", CompanyRef::DEFAULT)], true, true);
        let (raw, body) = batch(&["p1", "la"]);
        assert_eq!(
            r.receive(Some(&raw), Some(&sign_meta_body(&raw, SECRET)), &body, false)
                .await
                .unwrap(),
            2
        );
        assert_eq!(spy.forwarded.lock().unwrap().len(), 1);
        assert_eq!(spy.processed.lock().unwrap()[0].0, 1);
        // Toàn Page đã nối ⇒ không chuyển.
        let (r2, spy2) = receiver(false, &[("p1", CompanyRef::DEFAULT)], true, true);
        let (raw2, body2) = batch(&["p1"]);
        r2.receive(Some(&raw2), Some(&sign_meta_body(&raw2, SECRET)), &body2, false)
            .await
            .unwrap();
        assert!(spy2.forwarded.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn co_tinh_nang_tat_bo_qua_nhung_van_ok() {
        let (r, spy) = receiver(true, &[("p1", CompanyRef::DEFAULT)], false, false);
        let (raw, body) = batch(&["p1"]);
        assert_eq!(
            r.receive(Some(&raw), Some(&sign_meta_body(&raw, SECRET)), &body, false)
                .await
                .unwrap(),
            0
        );
        assert!(spy.processed.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn object_khac_page_hoac_entry_khong_phai_mang_la_0() {
        let (r, spy) = receiver(true, &[("p1", CompanyRef::DEFAULT)], true, true);
        for v in [
            json!({ "object": "instagram", "entry": [{ "id": "p1" }] }),
            json!({ "object": "page", "entry": "x" }),
            json!({}),
        ] {
            let raw = serde_json::to_vec(&v).unwrap();
            assert_eq!(
                r.receive(Some(&raw), Some(&sign_meta_body(&raw, SECRET)), &v, false)
                    .await
                    .unwrap(),
                0
            );
        }
        assert!(spy.processed.lock().unwrap().is_empty() && spy.forwarded.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn http_forwarder_chuyen_nguyen_van() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        // reqwest dùng `rustls-no-provider`: test tự cài provider `ring` (cài lần hai chỉ trả Err, bỏ qua).
        let _ = rustls::crypto::ring::default_provider().install_default();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/hook"))
            .and(header("x-trinity-forwarded", "1"))
            .and(header("x-hub-signature-256", "sha256=goc"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        let f = HttpForwarder {
            http: reqwest::Client::new(),
        };
        f.forward(&format!("{}/hook", server.uri()), b"{\"a\":1}", "sha256=goc");
        for _ in 0..50 {
            if !server.received_requests().await.unwrap_or_default().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let got = server.received_requests().await.unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].body, b"{\"a\":1}");
    }
}
