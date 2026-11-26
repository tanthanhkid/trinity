//! Kênh đồng bộ giữa tiến trình `trinity_sync` (Postgres `LISTEN/NOTIFY`), phía Rust (K36). Cùng định dạng với bản Node
//! (`packages/prisma/src/sync/sync-bus.ts`), hợp đồng ở `docs/sync-notify.md`:
//! `{"v":1,"o":"<origin>","k":"<kind>","c":<companyId>, ...}`, tối đa 7.500 byte, payload chỉ mang khoá.
//!
//! Luật ghi: **ghi DB trước rồi gửi tin**. [`publish_in_tx`] gửi bằng `pg_notify` trên chính giao dịch nghiệp vụ; Postgres
//! chỉ phát `NOTIFY` khi giao dịch commit (rollback thì không), nên bên nghe không bao giờ thấy tin về dòng chưa tồn tại.
//! Bên nghe: [`listen_from_env`] / [`listen`] (kết nối RIÊNG, không mượn pool của app; nối lại có lùi bước; mỗi lần mất kết
//! nối gửi [`SyncEvent::Resync`] để xoá cache và nạp lại từ các bảng bền). `TRINITY_SYNC=off` hoặc `TRINITY_RUNTIME=serverless`
//! ⇒ không nghe, như bản Node ([`sync_enabled`]).
//!
//! Tin do chính tiến trình này phát bị lọc khỏi bên nghe: bên gọi tự áp dụng thay đổi cục bộ (vd đẩy socket nội bộ từ dữ liệu
//! `create_notification` trả về) rồi mới gửi; chỉ các tiến trình khác nhận qua `NOTIFY`.

use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{Map, Value};
use sqlx::postgres::{PgConnectOptions, PgListener, PgPoolOptions};
use sqlx::{PgConnection, PgPool};

use crate::{DbConfig, DbError};
use tokio::sync::mpsc;

pub const SYNC_CHANNEL: &str = "trinity_sync";
pub const SYNC_VERSION: i64 = 1;
/// Giới hạn payload của Postgres là 8.000 byte; chừa chỗ an toàn (như bản Node).
pub const SYNC_MAX_BYTES: usize = 7_500;
/// Số id tối đa trong một mảng của tin `bell` (mỗi id ~8 byte): lớn hơn thì chia nhiều tin.
pub const BELL_CHUNK: usize = 200;

/// Các loại tin (`k`).
pub const KINDS: [&str; 7] = ["rbac", "token", "session", "cache", "bell", "payslip", "graph"];

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("payload {kind} vượt {SYNC_MAX_BYTES} byte ({len}); người gọi phải chia nhỏ")]
    TooLarge { kind: String, len: usize },
    #[error("loại tin không hợp lệ: {0}")]
    UnknownKind(String),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
}

/// Mã nguồn gốc của tiến trình này (`rust-<pid>-<hex>`), cố định suốt đời tiến trình.
pub fn origin() -> &'static str {
    static ORIGIN: OnceLock<String> = OnceLock::new();
    ORIGIN.get_or_init(|| {
        let id = uuid::Uuid::new_v4().simple().to_string();
        format!("rust-{}-{}", std::process::id(), &id[..8])
    })
}

/// Tin đã giải mã.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    pub origin: String,
    pub kind: String,
    /// Công ty (0 = không có ngữ cảnh công ty).
    pub company: i64,
    /// Toàn bộ object (gồm cả `v`, `o`, `k`, `c`).
    pub fields: Map<String, Value>,
}

/// Dựng chuỗi payload. `fields` không được trùng khoá `v/o/k/c` (khoá đó luôn do hàm này đặt).
pub fn build_payload(origin: &str, kind: &str, company: i64, fields: &Map<String, Value>) -> Result<String, SyncError> {
    if !KINDS.contains(&kind) {
        return Err(SyncError::UnknownKind(kind.to_owned()));
    }
    let mut m = Map::new();
    m.insert("v".into(), Value::from(SYNC_VERSION));
    m.insert("o".into(), Value::from(origin));
    m.insert("k".into(), Value::from(kind));
    m.insert("c".into(), Value::from(company));
    for (k, v) in fields {
        if !matches!(k.as_str(), "v" | "o" | "k" | "c") {
            m.insert(k.clone(), v.clone());
        }
    }
    let s = serde_json::to_string(&Value::Object(m)).expect("object JSON luôn serialize được");
    if s.len() > SYNC_MAX_BYTES {
        return Err(SyncError::TooLarge {
            kind: kind.to_owned(),
            len: s.len(),
        });
    }
    Ok(s)
}

/// Giải mã một payload thô. `None` nếu không phải JSON, sai phiên bản, thiếu `o/k/c` hoặc `k` lạ (người nghe bỏ qua, như Node).
pub fn parse_payload(raw: &str) -> Option<Envelope> {
    let Value::Object(fields) = serde_json::from_str::<Value>(raw).ok()? else {
        return None;
    };
    if fields.get("v")?.as_i64()? != SYNC_VERSION {
        return None;
    }
    let origin = fields.get("o")?.as_str()?.to_owned();
    let kind = fields.get("k")?.as_str()?.to_owned();
    let company = fields.get("c")?.as_i64()?;
    if !KINDS.contains(&kind.as_str()) {
        return None;
    }
    Some(Envelope {
        origin,
        kind,
        company,
        fields,
    })
}

/// Gửi một tin trên giao dịch/kết nối đang dùng. Trong giao dịch: chỉ phát khi commit.
pub async fn publish_in_tx(
    conn: &mut PgConnection,
    kind: &str,
    company: i64,
    fields: &Map<String, Value>,
) -> Result<(), SyncError> {
    let payload = build_payload(origin(), kind, company, fields)?;
    send(conn, &payload).await?;
    Ok(())
}

/// Tin `bell`: `u` = id người nhận, `n` = id `notification_logs` (bên nhận đọc nội dung từ DB). `n` rỗng ⇒ chỉ làm mới số
/// chưa đọc. Chia lô [`BELL_CHUNK`] để payload dưới giới hạn.
pub async fn publish_bell_in_tx(
    conn: &mut PgConnection,
    company: i64,
    user_ids: &[i32],
    notification_ids: &[i32],
) -> Result<(), SyncError> {
    let users = dedupe(user_ids);
    let ids = dedupe(notification_ids);
    if users.is_empty() && ids.is_empty() {
        return Ok(());
    }
    // Dựng HẾT payload trước khi gửi bất cứ tin nào: lỗi dựng (quá lớn) không để lại nửa chừng.
    let chunks = users
        .len()
        .div_ceil(BELL_CHUNK)
        .max(ids.len().div_ceil(BELL_CHUNK))
        .max(1);
    let mut payloads = Vec::with_capacity(chunks);
    for i in 0..chunks {
        let slice = |v: &[i32]| -> Value {
            Value::Array(
                v.iter()
                    .skip(i * BELL_CHUNK)
                    .take(BELL_CHUNK)
                    .map(|x| Value::from(*x))
                    .collect(),
            )
        };
        let mut f = Map::new();
        f.insert("u".into(), slice(&users));
        f.insert("n".into(), slice(&ids));
        payloads.push(build_payload(origin(), "bell", company, &f)?);
    }
    for p in payloads {
        send(&mut *conn, &p).await?;
    }
    Ok(())
}

/// Như [`publish_bell_in_tx`] nhưng KHÔNG làm hỏng giao dịch nghiệp vụ: gửi trong một `SAVEPOINT` (câu lỗi trong giao dịch
/// Postgres làm cả giao dịch hỏng, savepoint thì hoàn tác riêng phần tin); lỗi chỉ ghi log. Chỉ gọi trong giao dịch.
pub async fn publish_bell_best_effort(
    conn: &mut PgConnection,
    company: i64,
    user_ids: &[i32],
    notification_ids: &[i32],
) {
    if sqlx::query("SAVEPOINT trinity_bell").execute(&mut *conn).await.is_err() {
        tracing::warn!("sync: không tạo được savepoint cho tin bell (bỏ qua tin)");
        return;
    }
    match publish_bell_in_tx(&mut *conn, company, user_ids, notification_ids).await {
        Ok(()) => {
            if let Err(e) = sqlx::query("RELEASE SAVEPOINT trinity_bell").execute(&mut *conn).await {
                tracing::warn!("sync: RELEASE SAVEPOINT bell lỗi: {e}");
            }
        }
        Err(e) => {
            tracing::warn!("sync: không phát được tin bell (giao dịch nghiệp vụ vẫn giữ): {e}");
            if let Err(e2) = sqlx::query("ROLLBACK TO SAVEPOINT trinity_bell")
                .execute(&mut *conn)
                .await
            {
                tracing::warn!("sync: ROLLBACK TO SAVEPOINT bell lỗi: {e2}");
            }
        }
    }
}

async fn send(conn: &mut PgConnection, payload: &str) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_notify($1, $2)")
        .bind(SYNC_CHANNEL)
        .bind(payload)
        .execute(conn)
        .await?;
    Ok(())
}

/// Bỏ trùng, giữ thứ tự xuất hiện đầu tiên.
fn dedupe(v: &[i32]) -> Vec<i32> {
    let mut seen = HashSet::with_capacity(v.len());
    v.iter().copied().filter(|x| seen.insert(*x)).collect()
}

/// Sự kiện từ [`listen`].
#[derive(Debug, Clone, PartialEq)]
pub enum SyncEvent {
    /// Tin của tiến trình khác (tin của chính mình đã bị lọc).
    Message(Envelope),
    /// Vừa nối lại sau lúc đứt: tin trong lúc đứt đã mất ⇒ xoá cache cục bộ, nạp lại từ DB (các bảng bền).
    Resync,
}

/// Bật đồng bộ? `TRINITY_SYNC=off` hoặc `TRINITY_RUNTIME=serverless` ⇒ không (cùng luật `syncDisabled` của bản Node).
pub fn sync_enabled(get: impl Fn(&str) -> Option<String>) -> bool {
    let low = |k: &str| get(k).map(|v| v.trim().to_lowercase());
    low("TRINITY_SYNC").as_deref() != Some("off") && low("TRINITY_RUNTIME").as_deref() != Some("serverless")
}

/// Nghe theo biến môi trường: URL là `DIRECT_DATABASE_URL`, rồi `TENANT_DATABASE_URL`, rồi `DATABASE_URL` (cần nối trực tiếp,
/// không qua pooler). `Ok(None)` khi đồng bộ bị tắt. Lỗi chỉ khi URL thiếu/là pooler/không đọc được: người gọi báo rõ lúc khởi động.
pub fn listen_from_env() -> Result<Option<mpsc::Receiver<SyncEvent>>, DbError> {
    listen_with_lookup(|k| std::env::var(k).ok())
}

pub fn listen_with_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Option<mpsc::Receiver<SyncEvent>>, DbError> {
    if !sync_enabled(&get) {
        return Ok(None);
    }
    let url = ["DIRECT_DATABASE_URL", "TENANT_DATABASE_URL", "DATABASE_URL"]
        .iter()
        .find_map(|k| get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()))
        .ok_or(DbError::MissingUrl)?;
    let mut cfg = DbConfig::new(url);
    cfg.multi_tenant = get("MULTI_TENANT").as_deref() == Some("true");
    Ok(Some(listen(cfg.connect_options()?)))
}

/// Nghe kênh `trinity_sync` bằng kết nối RIÊNG (một pool một kết nối, không dùng chung pool của app). Tác vụ nền tự nối lại
/// với lùi bước tối đa 30 giây và dừng ngay khi bên nhận bị bỏ (kể cả đang chờ tin hoặc đang chờ nối lại). Lần nối đầu thất
/// bại không làm hỏng khởi động: lỗi ghi `tracing::error` (lần 1 và 5) rồi thử lại nền. Mất kết nối ⇒ [`SyncEvent::Resync`].
pub fn listen(opts: PgConnectOptions) -> mpsc::Receiver<SyncEvent> {
    let (tx, rx) = mpsc::channel(1024);
    tokio::spawn(async move {
        let mut attempt: u32 = 0;
        let mut was_connected = false;
        loop {
            let connected = tokio::select! {
                () = tx.closed() => return,
                r = connect(&opts) => r,
            };
            match connected {
                Ok(mut l) => {
                    attempt = 0;
                    if was_connected && tx.send(SyncEvent::Resync).await.is_err() {
                        return;
                    }
                    was_connected = true;
                    loop {
                        let got = tokio::select! {
                            () = tx.closed() => return,
                            r = l.try_recv() => r,
                        };
                        match got {
                            Ok(Some(n)) => {
                                let Some(env) = parse_payload(n.payload()).filter(|e| e.origin != origin()) else {
                                    continue;
                                };
                                if tx.send(SyncEvent::Message(env)).await.is_err() {
                                    return;
                                }
                            }
                            // `None`: kết nối đứt và sqlx đã nối lại; tin trong lúc đứt đã mất.
                            Ok(None) => {
                                tracing::warn!("sync: mất kết nối nghe, đã nối lại: nạp lại trạng thái");
                                if tx.send(SyncEvent::Resync).await.is_err() {
                                    return;
                                }
                            }
                            Err(e) => {
                                tracing::warn!("sync: mất kết nối nghe: {e}");
                                break;
                            }
                        }
                    }
                }
                Err(e) => {
                    attempt += 1;
                    if attempt == 1 || attempt == 5 {
                        tracing::error!(
                            "sync: không nối được kênh LISTEN ({e}). Đồng bộ giữa tiến trình đang TẮT, cache chỉ hết hạn theo TTL. \
                             Kiểm DIRECT_DATABASE_URL/DATABASE_URL (nối trực tiếp, không qua pooler) và tham số SSL; \
                             đặt TRINITY_SYNC=off nếu chỉ chạy một tiến trình."
                        );
                    }
                }
            }
            let delay = Duration::from_millis((500u64 << attempt.clamp(1, 6)).min(30_000));
            tokio::select! {
                () = tx.closed() => return,
                () = tokio::time::sleep(delay) => {}
            }
        }
    });
    rx
}

async fn connect(opts: &PgConnectOptions) -> Result<PgListener, sqlx::Error> {
    let pool: PgPool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(opts.clone())
        .await?;
    let mut l = PgListener::connect_with(&pool).await?;
    l.listen(SYNC_CHANNEL).await?;
    Ok(l)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect()
    }

    #[test]
    fn payload_khop_dinh_dang_node() {
        let p = build_payload("rust-1-ab", "rbac", 1, &f(&[("ids", Value::from("*"))])).unwrap();
        assert_eq!(p, r#"{"v":1,"o":"rust-1-ab","k":"rbac","c":1,"ids":"*"}"#);
        let e = parse_payload(&p).unwrap();
        assert_eq!(
            (e.origin.as_str(), e.kind.as_str(), e.company),
            ("rust-1-ab", "rbac", 1)
        );
    }

    #[test]
    fn khoa_phong_bi_khong_ghi_de() {
        let p = build_payload(
            "o1",
            "cache",
            2,
            &f(&[("o", Value::from("gia")), ("p", Value::from("x:"))]),
        )
        .unwrap();
        assert_eq!(parse_payload(&p).unwrap().origin, "o1");
    }

    #[test]
    fn tu_choi_loai_la_va_payload_qua_lon() {
        assert!(matches!(
            build_payload("o", "la", 1, &Map::new()),
            Err(SyncError::UnknownKind(_))
        ));
        let big = Value::from("x".repeat(8000));
        assert!(matches!(
            build_payload("o", "cache", 1, &f(&[("p", big)])),
            Err(SyncError::TooLarge { .. })
        ));
    }

    #[test]
    fn nghe_bo_tin_sai() {
        assert!(parse_payload("khong phai json").is_none());
        assert!(parse_payload(r#"{"v":2,"o":"a","k":"rbac","c":1}"#).is_none());
        assert!(parse_payload(r#"{"v":1,"o":"a","k":"la","c":1}"#).is_none());
        assert!(parse_payload(r#"{"v":1,"o":"a","k":"rbac"}"#).is_none());
        assert!(parse_payload(r#"{"v":1,"o":"a","k":"graph","c":0,"ok":true}"#).is_some());
    }

    #[test]
    fn dedupe_giu_thu_tu() {
        assert_eq!(dedupe(&[7, 6, 7, 1, 6]), vec![7, 6, 1]);
    }

    #[test]
    fn tat_dong_bo_nhu_node() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| pairs.iter().find(|(a, _)| *a == k).map(|(_, v)| (*v).to_owned())
        };
        assert!(sync_enabled(env(&[])));
        assert!(!sync_enabled(env(&[("TRINITY_SYNC", " OFF ")])));
        assert!(!sync_enabled(env(&[("TRINITY_RUNTIME", "Serverless")])));
        assert!(matches!(listen_with_lookup(env(&[("TRINITY_SYNC", "off")])), Ok(None)));
        assert!(matches!(listen_with_lookup(env(&[])), Err(DbError::MissingUrl)));
    }

    #[test]
    fn origin_co_dang_rust() {
        assert!(origin().starts_with("rust-"));
        assert_eq!(origin(), origin());
    }
}
