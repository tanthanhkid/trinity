//! Tải video theo phần (X15a) trên Postgres thật với kho đĩa cục bộ. Pool chỉ 1 kết nối (mã giữ kết nối khi ghi kho sẽ treo).
//! Dữ liệu mang tiền tố `x15a`, tự dọn.
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-social --test chunked_pg -- --ignored`

use std::sync::Arc;
use std::time::Duration;

use mod_facebook::config::Env;
use mod_social::chunked::{self, InitBody, PART_BYTES, SESSION_TTL_MS};
use mod_social::media::{MediaCtx, MediaStore};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_storage::LocalDiskDriver;

const NOW: i64 = 1_800_000_000_000;

fn status(e: trinity_kernel::error::AppError) -> (u16, String) {
    let (s, b) = e.response(true);
    (s, serde_json::to_string(&b.message).unwrap())
}

async fn clean(c: &mut PgConnection) {
    sqlx::query("DELETE FROM social_media_assets WHERE name LIKE 'x15a%'")
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE email LIKE 'x15a%@test.local'")
        .execute(&mut *c)
        .await
        .unwrap();
}

fn body(name: &str, size: u64) -> InitBody {
    InitBody {
        file_name: name.to_owned(),
        size,
    }
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn tai_video_theo_phan() {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 1;
    cfg.acquire_timeout = Duration::from_secs(3);
    let db = Db::connect(&cfg).await.expect("nối DB");
    let company = CompanyRef::DEFAULT;
    let root = std::env::temp_dir().join(format!("x15a-{}", std::process::id()));
    let local = LocalDiskDriver::new(&root);
    local.init().await.unwrap();
    let store = MediaStore::Local(local);

    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    clean(&mut c).await;
    let user: i32 = sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, full_name, status, updated_at) \
         VALUES ('x15aa@test.local', 'x', 'X15a', 'active', now()) RETURNING id",
    )
    .fetch_one(&mut *c)
    .await
    .unwrap();
    drop(c);

    // `SOCIAL_MAX_VIDEO_MB=95` (sau proxy) không chặn đường theo phần.
    let env: Env = Arc::new(|k| (k == "SOCIAL_MAX_VIDEO_MB").then(|| "95".to_owned()));
    let ctx = |user_id: i32, now_ms: i64| MediaCtx {
        db: &db,
        company,
        store: &store,
        env: &env,
        user_id,
        now_ms,
    };
    let me = ctx(user, NOW);
    let dir = |id: &str| root.join("social/chunks").join(id);

    // Khai phiên: ảnh ⇒ 400, quá 200 MB ⇒ 413.
    assert_eq!(
        status(chunked::init(&me, &body("x15a.png", 10)).await.unwrap_err()).0,
        400
    );
    let (s, msg) = status(
        chunked::init(&me, &body("x15a.mp4", 200 * 1024 * 1024 + 1))
            .await
            .unwrap_err(),
    );
    assert_eq!((s, msg.as_str()), (413, "\"Tệp quá lớn (tối đa 200 MB).\""));

    // Video 16 MB + 5 byte ⇒ 2 phần; gửi phần cuối trước, phần sai cỡ bị từ chối và không để lại tệp.
    let total = PART_BYTES + 5;
    let init = chunked::init(&me, &body("x15a.mp4", total)).await.unwrap();
    assert_eq!((init.total_parts, init.part_size), (2, PART_BYTES));
    let id = init.upload_id.as_str();
    chunked::put_part(&me, id, 1, &[7_u8; 5][..]).await.unwrap();
    let (s, _) = status(chunked::put_part(&me, id, 0, &[1_u8; 10][..]).await.unwrap_err());
    assert_eq!(s, 400, "thiếu byte");
    let big = vec![1_u8; usize::try_from(PART_BYTES).unwrap() + 1];
    let (s, _) = status(chunked::put_part(&me, id, 0, &big[..]).await.unwrap_err());
    assert_eq!(s, 413, "thừa byte");
    assert_eq!(status_of(&me, id).await, vec![1]);
    assert_eq!(
        status(chunked::put_part(&me, id, 2, &[0_u8; 1][..]).await.unwrap_err()).0,
        400,
        "chỉ số ngoài phiên"
    );

    // Người khác (hoặc id lạ) không thấy phiên; ghép khi còn thiếu ⇒ 400 nêu phần thiếu, phiên còn nguyên.
    let other = ctx(user + 1, NOW);
    assert_eq!(status(chunked::status(&other, id).await.unwrap_err()).0, 404);
    assert_eq!(status(chunked::status(&me, "../x").await.unwrap_err()).0, 404);
    let (s, msg) = status(chunked::complete(&me, id).await.unwrap_err());
    assert_eq!((s, msg.as_str()), (400, "\"Còn thiếu phần: 0.\""));

    // Rớt mạng rồi gửi nốt phần 0 (gửi lại phần 1 cũng được: ghi đè) ⇒ ghép đúng thứ tự, đúng cỡ, vào thư viện.
    let p0 = vec![3_u8; usize::try_from(PART_BYTES).unwrap()];
    chunked::put_part(&me, id, 0, &p0[..]).await.unwrap();
    chunked::put_part(&me, id, 1, &[9_u8; 5][..]).await.unwrap();
    assert_eq!(status_of(&me, id).await, vec![0, 1]);
    let m = chunked::complete(&me, id).await.unwrap();
    assert_eq!(
        (m.r#type.as_str(), m.content_type.as_str(), m.size),
        ("video", "video/mp4", total)
    );
    assert_eq!(store.size_of(&m.key).await.unwrap(), total);
    assert!(!dir(id).exists(), "ghép xong thì xoá phiên");
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM social_media_assets WHERE key = $1 AND source = 'web'")
        .bind(&m.key)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(n, 1);
    drop(c);
    assert_eq!(
        status(chunked::complete(&me, id).await.unwrap_err()).0,
        404,
        "phiên đã đóng"
    );

    // Huỷ giữa chừng: không còn tệp nào; huỷ lại và huỷ id lạ vẫn êm.
    let id2 = chunked::init(&me, &body("x15a.mov", total)).await.unwrap().upload_id;
    chunked::put_part(&me, &id2, 1, &[7_u8; 5][..]).await.unwrap();
    assert!(dir(&id2).exists());
    chunked::cancel(&other, &id2).await.unwrap();
    assert!(dir(&id2).exists(), "người khác huỷ không xoá được");
    chunked::cancel(&me, &id2).await.unwrap();
    assert!(!dir(&id2).exists(), "huỷ xong không để lại tệp rác");
    chunked::cancel(&me, &id2).await.unwrap();
    chunked::cancel(&me, "../x").await.unwrap();
    assert_eq!(
        status(chunked::put_part(&me, &id2, 1, &[7_u8; 5][..]).await.unwrap_err()).0,
        404
    );

    // Phiên quá hạn bị dọn khi chạm tới; phiên bị bỏ quên bị `sweep_local` dọn.
    let id3 = chunked::init(&me, &body("x15a.webm", total)).await.unwrap().upload_id;
    chunked::put_part(&me, &id3, 1, &[7_u8; 5][..]).await.unwrap();
    let late = ctx(user, NOW + SESSION_TTL_MS + 1);
    assert_eq!(status(chunked::status(&late, &id3).await.unwrap_err()).0, 404);
    assert!(!dir(&id3).exists());
    let id4 = chunked::init(&me, &body("x15a.mp4", total)).await.unwrap().upload_id;
    assert_eq!(chunked::sweep_local(&root, NOW).await, 0, "chưa quá hạn");
    assert_eq!(chunked::sweep_local(&root, NOW + SESSION_TTL_MS + 1).await, 1);
    assert!(!dir(&id4).exists());

    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    clean(&mut c).await;
    let _ = std::fs::remove_dir_all(root);
}

async fn status_of(c: &MediaCtx<'_>, id: &str) -> Vec<u32> {
    chunked::status(c, id).await.unwrap().received
}
