//! Kênh đồng bộ giữa tiến trình `trinity_sync` (Postgres `LISTEN/NOTIFY`), phía Rust (K36). Cùng định dạng với bản Node
//! (`packages/prisma/src/sync/sync-bus.ts`), hợp đồng ở `docs/sync-notify.md`:
//! `{"v":1,"o":"<origin>","k":"<kind>","c":<companyId>, ...}`, tối đa 7.500 byte, payload chỉ mang khoá.
//!
//! Luật ghi: **ghi DB trước rồi gửi tin**. [`publish_in_tx`] gửi bằng `pg_notify` trên chính giao dịch nghiệp vụ; Postgres
//! chỉ phát `NOTIFY` khi giao dịch commit (rollback thì không), nên bên nghe không bao giờ thấy tin về dòng chưa tồn tại.
//! Bên nghe: [`listen`] (nối lại có lùi bước; sau mỗi lần nối lại gửi [`SyncEvent::Resync`] để xoá cache và nạp lại từ DB).

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{Map, Value};
use sqlx::postgres::PgListener;
use sqlx::{PgConnection, PgPool};
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
    sqlx::query("SELECT pg_notify($1, $2)")
        .bind(SYNC_CHANNEL)
        .bind(payload)
        .execute(conn)
        .await?;
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
    let mut users: Vec<i32> = Vec::new();
    for u in user_ids {
        if !users.contains(u) {
            users.push(*u);
        }
    }
    let mut ids: Vec<i32> = Vec::new();
    for n in notification_ids {
        if !ids.contains(n) {
            ids.push(*n);
        }
    }
    if users.is_empty() && ids.is_empty() {
        return Ok(());
    }
    let chunks = users
        .len()
        .div_ceil(BELL_CHUNK)
        .max(ids.len().div_ceil(BELL_CHUNK))
        .max(1);
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
        publish_in_tx(&mut *conn, "bell", company, &f).await?;
    }
    Ok(())
}

/// Sự kiện từ [`listen`].
#[derive(Debug, Clone, PartialEq)]
pub enum SyncEvent {
    /// Tin của tiến trình khác (tin của chính mình đã bị lọc).
    Message(Envelope),
    /// Vừa nối lại sau lúc đứt: tin trong lúc đứt đã mất ⇒ xoá cache cục bộ, nạp lại từ DB (các bảng bền).
    Resync,
}

/// Nghe kênh `trinity_sync` trên `pool` (cần kết nối trực tiếp/session-mode). Trả bên nhận; tác vụ nền tự nối lại với lùi
/// bước tối đa 30 giây và dừng khi bên nhận bị bỏ. Lần nối đầu thất bại không làm hỏng khởi động: lỗi được ghi `tracing::error`
/// (lần 1 và lần 5) rồi thử lại nền.
pub fn listen(pool: PgPool) -> mpsc::Receiver<SyncEvent> {
    let (tx, rx) = mpsc::channel(1024);
    tokio::spawn(async move {
        let mut attempt: u32 = 0;
        loop {
            match connect(&pool).await {
                Ok(mut l) => {
                    if attempt > 0 && tx.send(SyncEvent::Resync).await.is_err() {
                        return;
                    }
                    loop {
                        match l.recv().await {
                            Ok(n) => {
                                let Some(env) = parse_payload(n.payload()).filter(|e| e.origin != origin()) else {
                                    continue;
                                };
                                if tx.send(SyncEvent::Message(env)).await.is_err() {
                                    return;
                                }
                            }
                            Err(e) => {
                                tracing::warn!("sync: mất kết nối nghe: {e}");
                                break;
                            }
                        }
                    }
                    attempt = 1; // đã từng nối được: lần nối lại tiếp theo phải Resync
                }
                Err(e) => {
                    attempt += 1;
                    if attempt == 1 || attempt == 5 {
                        tracing::error!(
                            "sync: không nối được kênh LISTEN ({e}). Đồng bộ giữa tiến trình đang TẮT, cache chỉ hết hạn theo TTL. \
                             Kiểm DATABASE_URL/DIRECT_DATABASE_URL (nối trực tiếp, không qua pooler) và tham số SSL."
                        );
                    }
                }
            }
            if tx.is_closed() {
                return;
            }
            let delay = Duration::from_millis((500u64 << attempt.clamp(1, 6)).min(30_000));
            tokio::time::sleep(delay).await;
        }
    });
    rx
}

async fn connect(pool: &PgPool) -> Result<PgListener, sqlx::Error> {
    let mut l = PgListener::connect_with(pool).await?;
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
    fn origin_co_dang_rust() {
        assert!(origin().starts_with("rust-"));
        assert_eq!(origin(), origin());
    }
}
