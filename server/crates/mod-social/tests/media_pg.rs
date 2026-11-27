//! Thư viện media trên Postgres thật với kho đĩa cục bộ. Pool chỉ 1 kết nối: mã giữ kết nối khi ghi kho hoặc xin kết nối thứ
//! hai sẽ treo rồi hết hạn chờ. Dữ liệu mang tiền tố `m53b`, tự dọn.
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-social --test media_pg -- --ignored`

use std::sync::Arc;
use std::time::Duration;

use mod_facebook::config::Env;
use mod_social::media::{self, LibraryQuery, MediaCtx, MediaStore};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_storage::LocalDiskDriver;

const NOW: i64 = 1_800_000_000_000;

fn env_for(max_video_mb: Option<&'static str>) -> Env {
    Arc::new(move |k| match k {
        "SOCIAL_MAX_VIDEO_MB" => max_video_mb.map(str::to_owned),
        _ => None,
    })
}

fn status(e: trinity_kernel::error::AppError) -> (u16, String) {
    let (s, b) = e.response(true);
    (s, serde_json::to_string(&b.message).unwrap())
}

async fn clean(c: &mut PgConnection) {
    sqlx::query("DELETE FROM social_media_assets WHERE name LIKE 'm53b%'")
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE email LIKE 'm53b%@test.local'")
        .execute(&mut *c)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn thu_vien_media_day_du() {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 1;
    cfg.acquire_timeout = Duration::from_secs(3);
    let db = Db::connect(&cfg).await.expect("nối DB");
    let company = CompanyRef::DEFAULT;
    let root = std::env::temp_dir().join(format!("m53b-{}", std::process::id()));
    let local = LocalDiskDriver::new(&root);
    local.init().await.unwrap();
    let store = MediaStore::Local(local);

    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    clean(&mut c).await;
    let user: i32 = sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, full_name, status, updated_at) \
         VALUES ('m53ba@test.local', 'x', 'M53b', 'active', now()) RETURNING id",
    )
    .fetch_one(&mut *c)
    .await
    .unwrap();
    drop(c);

    let env = env_for(Some("1"));
    let ctx = MediaCtx {
        db: &db,
        company,
        store: &store,
        env: &env,
        user_id: user,
        now_ms: NOW,
    };

    // Đuôi lạ ⇒ 400; tải ảnh hợp lệ qua luồng ⇒ vào thư viện, size đúng số byte.
    let (s, _) = status(media::upload_stream(&ctx, "m53b.pdf", &b"x"[..]).await.unwrap_err());
    assert_eq!(s, 400);
    let png = vec![1_u8; 2048];
    let m = media::upload_stream(&ctx, "m53b-anh.PNG", &png[..]).await.unwrap();
    assert_eq!((m.r#type.as_str(), m.content_type.as_str(), m.size), ("image", "image/png", 2048));
    assert_eq!(media::parse_key(&m.key), Some(user as u64));

    // Video vượt trần env (1 MB) ⇒ 413 câu của Trinity, không để lại dòng thư viện.
    let big = vec![0_u8; 1024 * 1024 + 1];
    let (s, msg) = status(media::upload_stream(&ctx, "m53b.mp4", &big[..]).await.unwrap_err());
    assert_eq!((s, msg.as_str()), (413, "\"Tệp quá lớn (tối đa 1 MB).\""));

    // Thư viện: lọc theo tên (escape LIKE), loại, con trỏ.
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let q = LibraryQuery::from_query(Some("image"), Some("M53B-ANH"), None, None).unwrap();
    let page = media::list(&mut c, &q).await.unwrap();
    assert_eq!(page.data.len(), 1);
    assert_eq!(page.data[0].name, "m53b-anh.PNG");
    let q = LibraryQuery::from_query(None, Some("m53b%"), None, None).unwrap();
    assert!(media::list(&mut c, &q).await.unwrap().data.is_empty(), "% là ký tự thường");
    let id = page.data[0].id;
    drop(c);

    // resolve: của mình thì qua; khoá lạ ⇒ 400; khoá của người khác chỉ qua khi đang ở thư viện chung.
    let ok = media::resolve(&ctx, std::slice::from_ref(&m.key)).await.unwrap();
    assert_eq!(ok[0].size, 2048);
    let (s, _) = status(media::resolve(&ctx, &["social/u999999_1_aaaaaa.png".to_owned()]).await.unwrap_err());
    assert_eq!(s, 400);

    // Xem trước rồi ẩn: sau khi ẩn ⇒ 404 và không còn trong thư viện, tệp trong kho vẫn còn.
    let f = media::open(&db, company, &store, id).await.unwrap();
    assert_eq!((f.content_type.as_str(), f.content_length), ("image/png", Some(2048)));
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    assert_eq!(media::hide(&mut c, id).await.unwrap()["hidden"], true);
    assert_eq!(status(media::hide(&mut c, id).await.unwrap_err()).0, 404);
    drop(c);
    assert_eq!(status(media::open(&db, company, &store, id).await.err().unwrap()).0, 404);

    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    clean(&mut c).await;
    let _ = std::fs::remove_dir_all(root);
}
