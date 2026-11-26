use std::io::Write;
use std::sync::{Arc, Mutex};

use super::*;

/// Bộ đệm nhận log để kiểm.
#[derive(Clone, Default)]
struct Buf(Arc<Mutex<Vec<u8>>>);

impl Write for Buf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for Buf {
    type Writer = Buf;
    fn make_writer(&'a self) -> Buf {
        self.clone()
    }
}

fn capture(f: impl FnOnce()) -> Vec<serde_json::Value> {
    let buf = Buf::default();
    tracing::subscriber::with_default(json_subscriber(buf.clone(), EnvFilter::new("info")), f);
    let text = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
    text.lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("dòng log không phải JSON ({e}): {l}")))
        .collect()
}

fn raw(f: impl FnOnce()) -> String {
    let buf = Buf::default();
    tracing::subscriber::with_default(json_subscriber(buf.clone(), EnvFilter::new("info")), f);
    String::from_utf8(buf.0.lock().unwrap().clone()).unwrap()
}

#[test]
fn token_trong_duong_dan_webhook_khong_vao_log() {
    let hasher = UserIdHasher::new("khoa-thu").unwrap();
    let user = hasher.hash("42");
    let req = RequestLog {
        correlation_id: "abc-1",
        method: "POST",
        url: "/api/v1/hooks/in/whk_SECRET_TOKEN_123?x=1",
        status: 201,
        duration: Duration::from_millis(37),
        user_hash: Some(&user),
    };
    let text = raw(|| log_request(&req));
    assert!(!text.contains("whk_SECRET_TOKEN_123"), "token lọt vào log: {text}");
    let lines = capture(|| log_request(&req));
    assert_eq!(lines.len(), 1);
    let l = &lines[0];
    assert_eq!(l["url"], "/api/v1/hooks/in/[redacted]?x=1");
    assert_eq!(l["correlation_id"], "abc-1");
    assert_eq!(l["method"], "POST");
    assert_eq!(l["status_code"], 201);
    assert_eq!(l["duration_ms"], 37);
    assert_eq!(l["user_id"], user.as_str());
    assert_eq!(l["level"], "INFO");
    assert_eq!(l["message"], "request");
    assert!(l["timestamp"].is_string());
}

#[test]
fn che_token_code_state_trong_query() {
    let req = RequestLog {
        correlation_id: "c",
        method: "GET",
        url: "/api/v1/zalo-oa/oauth/callback?code=OAUTH_CODE_X&state=STATE_Y&token=TOK_Z&page=2",
        status: 302,
        duration: Duration::ZERO,
        user_hash: None,
    };
    let text = raw(|| log_request(&req));
    for secret in ["OAUTH_CODE_X", "STATE_Y", "TOK_Z"] {
        assert!(!text.contains(secret), "{secret} lọt vào log: {text}");
    }
    let l = &capture(|| log_request(&req))[0];
    assert_eq!(
        l["url"],
        "/api/v1/zalo-oa/oauth/callback?code=[redacted]&state=[redacted]&token=[redacted]&page=2"
    );
    assert_eq!(l["user_id"], "anonymous");
}

#[test]
fn muc_log_theo_ma_trang_thai() {
    let mk = |status| RequestLog {
        correlation_id: "c",
        method: "GET",
        url: "/x",
        status,
        duration: Duration::ZERO,
        user_hash: None,
    };
    let lines = capture(|| {
        log_request(&mk(200));
        log_request(&mk(404));
        log_request(&mk(503));
    });
    let levels: Vec<&str> = lines.iter().map(|l| l["level"].as_str().unwrap()).collect();
    assert_eq!(levels, ["INFO", "WARN", "ERROR"]);
}

#[test]
fn ma_tuong_quan() {
    assert_eq!(correlation_id(Some("req-7f3a:1")), "req-7f3a:1");
    assert_eq!(correlation_id(Some("  abc  ")), "abc");
    // Header lạ (chèn dòng, quá dài, rỗng) ⇒ sinh mã mới, không ghi nguyên văn vào log.
    for bad in [Some("a\nb"), Some("x y"), Some(""), None] {
        let id = correlation_id(bad);
        assert!(!id.is_empty() && id.contains('-') && !id.contains(['\n', ' ']), "{id}");
    }
    assert_ne!(correlation_id(Some(&"a".repeat(129))), "a".repeat(129));
    assert_ne!(new_correlation_id(), new_correlation_id());
    // <tiến trình 8 hex>-<thời điểm>-<bộ đếm>; cùng tiến trình thì cùng phần đầu.
    let (a, b) = (new_correlation_id(), new_correlation_id());
    assert_eq!(a.split('-').count(), 3, "{a}");
    assert_eq!(a.split('-').next().unwrap().len(), 8, "{a}");
    assert_eq!(a.split('-').next(), b.split('-').next());
}

#[test]
fn bam_user_id_giong_ban_node() {
    // createHmac('sha256', 'secret').update('42').digest('hex').slice(0, 24)
    assert_eq!(
        UserIdHasher::new("secret").unwrap().hash("42"),
        "93c121e7aa437a1e01e3c512"
    );
}

#[test]
fn khoa_bam_rong_bi_tu_choi() {
    assert_eq!(UserIdHasher::new("").unwrap_err(), EmptyHashKey);
}

#[test]
fn log_tu_crate_log_ra_json() {
    // Cầu nối là toàn cục; test khác có thể đã cài — lỗi "đã cài" bỏ qua.
    let _ = install_log_bridge();
    let lines = capture(|| log::warn!(target: "sqlx::query", "slow statement: elapsed=1.2s"));
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["level"], "WARN");
    assert_eq!(lines[0]["message"], "slow statement: elapsed=1.2s");
    assert_eq!(lines[0]["target"], "sqlx::query");
}

#[test]
fn bo_loc_co_dinh_khong_doc_rust_log() {
    // Mức debug bị lọc ở bộ lọc "info" của test, bất kể RUST_LOG của máy chạy test.
    let lines = capture(|| tracing::debug!("ẩn"));
    assert!(lines.is_empty());
}

#[test]
fn rust_log_sai_cu_phap_bao_mot_cau() {
    assert!(filter_from(None).1.is_none());
    assert!(filter_from(Some("debug,hyper=warn")).1.is_none());
    let (_, warn) = filter_from(Some("trinity=khongphaimuc"));
    assert!(warn.unwrap().starts_with("RUST_LOG=trinity=khongphaimuc sai cú pháp"));
}
