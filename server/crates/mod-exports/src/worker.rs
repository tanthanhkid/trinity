//! Bộ xử lý việc `export.run` của worker hàng đợi (K21).
//!
//! Việc xếp tối đa [`MAX_ATTEMPTS`] lần: lần cuối lỗi thì dòng `failed` kèm câu lỗi; các lần trước giữ `running` để web
//! vẫn thấy đang chạy. Không giữ kết nối `platform` trong lúc dựng tệp (kết nối tenant của hàm xuất được trả trước khi
//! ghi kết quả).

use serde::Deserialize;
use serde_json::Value;
use trinity_db::Db;
use trinity_jobs::{Job, Worker};

use crate::store::{MAX_BYTES, Store};
use crate::{ExportFile, JOB_KIND, contacts};

/// Số lần thử của một việc xuất (dựng lại tệp lớn tốn máy nên không thử nhiều).
pub const MAX_ATTEMPTS: i32 = 2;

#[derive(Debug, Deserialize)]
struct Payload {
    export_id: i64,
    kind: String,
}

/// Dựng tệp theo loại. Thêm loại xuất mới ở đây.
pub async fn build(db: &Db, company: i32, kind: &str, payload: &Value) -> Result<ExportFile, String> {
    match kind {
        contacts::KIND => contacts::build(db, company, payload).await,
        other => Err(format!("loại xuất không hỗ trợ: {other}")),
    }
}

async fn run(db: &Db, store: &Store, job: Job) -> Result<(), String> {
    let p: Payload = serde_json::from_value(job.payload.clone()).map_err(|e| format!("payload hỏng: {e}"))?;
    let company = job.company_id;
    if !store
        .mark_running(p.export_id, company)
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let last = job.attempts >= job.max_attempts;
    let built = match build(db, company, &p.kind, &job.payload).await {
        Ok(f) if f.data.len() > MAX_BYTES => Err(format!(
            "tệp {} MB vượt giới hạn {} MB; thu hẹp bộ lọc rồi xuất lại",
            f.data.len() / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        )),
        other => other,
    };
    match built {
        Ok(file) => {
            // Ghi phụ: không làm hỏng việc chính nếu cập nhật tiến độ lỗi.
            let _ = store.set_progress(p.export_id, company, 90).await;
            store
                .finish(p.export_id, company, &file.filename, file.content_type, file.data)
                .await
                .map_err(|e| e.to_string())
        }
        Err(msg) => {
            if last {
                let _ = store.fail(p.export_id, company, &msg).await;
            }
            Err(msg)
        }
    }
}

/// Đăng ký bộ xử lý vào worker (gọi trước khi `clone`/`run` worker).
pub fn register(worker: &mut Worker, db: &Db) {
    let store = Store::new(db);
    let db = db.clone();
    worker.handle(JOB_KIND, move |job| {
        let (db, store) = (db.clone(), store.clone());
        async move { run(&db, &store, job).await }
    });
}
