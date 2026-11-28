//! M22: bảng tin trên Postgres thật. Cần DB riêng đã áp `contracts/schema.sql` (bảng của test bị TRUNCATE):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-newsfeed --test pg -- --ignored --test-threads=1`

use mod_newsfeed::{Actor, Error, ImageUpload, VideoUpload};
use sqlx::Row;
use trinity_db::{CompanyRef, Db, DbConfig, TenantDb};
use trinity_storage::LocalDiskDriver;

const PNG: [u8; 70] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
    0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0x60, 0xf8, 0x5f, 0x0f, 0x00, 0x02, 0x87, 0x01, 0x80, 0xeb, 0x47, 0xba,
    0x92, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

async fn setup() -> (TenantDb, LocalDiskDriver) {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut c = DbConfig::new(url);
    c.pool_size = 4;
    let db = Db::connect(&c).await.expect("kết nối DB");
    let t = db.tenant(CompanyRef::new(1).unwrap()).await.unwrap();
    let mut conn = t.acquire().await.unwrap();
    sqlx::query("TRUNCATE newsfeed_posts, notification_logs, users RESTART IDENTITY CASCADE")
        .execute(&mut *conn)
        .await
        .unwrap();
    for (id, status) in [(1, "active"), (2, "active"), (3, "inactive"), (4, "active")] {
        sqlx::query("INSERT INTO users (id, email, password_hash, full_name, status, updated_at) VALUES ($1, $2, 'x', $3, $4, now())")
            .bind(id)
            .bind(format!("u{id}@example.com"))
            .bind(format!("Người {id}"))
            .bind(status)
            .execute(&mut *conn)
            .await
            .unwrap();
    }
    let dir = std::env::temp_dir().join(format!("m22-{}", uuid_like()));
    let store = LocalDiskDriver::new(dir);
    store.init().await.unwrap();
    (t, store)
}

fn uuid_like() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

fn actor(id: i32, post: bool, moderate: bool) -> Actor {
    Actor {
        user_id: id,
        can_post: post,
        can_moderate: moderate,
    }
}

/// Đăng bài rồi chờ tác vụ nền gửi thông báo xong (hoặc bỏ cuộc), để test sau không bị việc nền của test trước chạm vào.
async fn create_t(
    db: &TenantDb,
    store: &LocalDiskDriver,
    actor: &Actor,
    category: &str,
    content: &str,
    images: Vec<ImageUpload>,
    videos: &[VideoUpload],
) -> Result<mod_newsfeed::Post, Error> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let r = mod_newsfeed::create(db, store, actor, category, content, images, videos, move |c| {
        let _ = tx.send(c);
    })
    .await;
    let _ = rx.await;
    r
}

async fn lst(
    db: &TenantDb,
    actor: &Actor,
    category: Option<&str>,
    cursor: Option<i64>,
    limit: Option<i64>,
) -> Result<mod_newsfeed::Page<mod_newsfeed::Post>, Error> {
    let q = mod_newsfeed::ListQuery {
        category: category.map(str::to_owned),
        cursor,
        limit,
    };
    mod_newsfeed::list(db, actor, &q).await
}

fn status(e: Error) -> u16 {
    match e {
        Error::Http(h) => h.status(),
        Error::Internal(m) => panic!("lỗi nội bộ: {m}"),
    }
}

fn json<T: serde::Serialize>(v: &T) -> serde_json::Value {
    serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn dang_bai_thong_bao_va_hinh_json() {
    let (db, store) = setup().await;
    let a = actor(1, true, false);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let post = mod_newsfeed::create(
        &db,
        &store,
        &a,
        "announcement",
        "  <p>Xin&nbsp;chào <b>cả</b> nhà</p>  ",
        vec![],
        &[],
        move |c| {
            let _ = tx.send(c);
        },
    )
    .await
    .unwrap();
    // Tác vụ nền trả các dòng thông báo đã commit để router đẩy socket nội bộ.
    let pushed = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pushed.iter().map(|n| n.recipient_id).collect::<Vec<_>>(), [2, 4]);
    assert!(
        pushed
            .iter()
            .all(|n| n.event_type == "newsfeed.post.created" && n.id > 0)
    );
    let v = json(&post);
    let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "id",
            "category",
            "author_id",
            "content",
            "image_url",
            "edited_at",
            "created_at",
            "author",
            "images",
            "_count",
            "liked_by_me"
        ]
    );
    assert_eq!(v["content"], "<p>Xin&nbsp;chào <b>cả</b> nhà</p>");
    assert_eq!(v["author"]["full_name"], "Người 1");
    assert_eq!(v["_count"], serde_json::json!({"likes": 0, "comments": 0}));
    assert_eq!(v["liked_by_me"], false);
    assert!(v["created_at"].as_str().unwrap().ends_with('Z'));

    // Thông báo: người dùng đang hoạt động trừ người đăng (2 và 4; 3 khoá).
    let mut conn = db.acquire().await.unwrap();
    let rows = sqlx::query(
        "SELECT recipient_id, event_type, title, body, action_url FROM notification_logs ORDER BY recipient_id",
    )
    .fetch_all(&mut *conn)
    .await
    .unwrap();
    let got: Vec<(i32, String, String, String, Option<String>)> = rows
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4)))
        .collect();
    let url = format!("/newsfeed?post={}", post.id);
    assert_eq!(
        got,
        [2, 4]
            .map(|u| (
                u,
                "newsfeed.post.created".to_owned(),
                "Bài đăng mới • Thông báo".to_owned(),
                "Người 1: Xin chào cả nhà".to_owned(),
                Some(url.clone())
            ))
            .to_vec()
    );
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn kiem_tra_dau_vao_khi_dang() {
    let (db, store) = setup().await;
    let a = actor(1, true, false);
    let e = create_t(&db, &store, &a, "pr", "   ", vec![], &[]).await.unwrap_err();
    assert_eq!(status(e), 400);
    let bad = ImageUpload {
        content_type: "image/gif".into(),
        bytes: vec![1, 2, 3],
    };
    assert_eq!(
        status(create_t(&db, &store, &a, "pr", "x", vec![bad], &[]).await.unwrap_err()),
        400
    );
    let not_image = ImageUpload {
        content_type: "image/png".into(),
        bytes: vec![1, 2, 3],
    };
    assert_eq!(
        status(
            create_t(&db, &store, &a, "pr", "x", vec![not_image], &[])
                .await
                .unwrap_err()
        ),
        400
    );
    let many: Vec<ImageUpload> = (0..11)
        .map(|_| ImageUpload {
            content_type: "image/png".into(),
            bytes: PNG.to_vec(),
        })
        .collect();
    assert_eq!(
        status(create_t(&db, &store, &a, "pr", "x", many, &[]).await.unwrap_err()),
        400
    );
    let tmp = std::env::temp_dir().join(format!("m22-bad-{}.avi", uuid_like()));
    tokio::fs::write(&tmp, b"x").await.unwrap();
    let v = VideoUpload {
        file_name: "a.avi".into(),
        size: 1,
        path: tmp.clone(),
    };
    assert_eq!(
        status(create_t(&db, &store, &a, "pr", "x", vec![], &[v]).await.unwrap_err()),
        400
    );
    assert!(!tmp.exists(), "tệp tạm phải được dọn kể cả khi lỗi");
    let mut conn = db.acquire().await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM newsfeed_posts")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn anh_video_stream_va_xoa() {
    let (db, store) = setup().await;
    let a = actor(1, true, false);
    let video_bytes: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
    let tmp = std::env::temp_dir().join(format!("m22-v-{}.MP4", uuid_like()));
    tokio::fs::write(&tmp, &video_bytes).await.unwrap();
    let img = ImageUpload {
        content_type: "image/png".into(),
        bytes: PNG.to_vec(),
    };
    let vid = VideoUpload {
        file_name: "clip.MP4".into(),
        size: 1000,
        path: tmp.clone(),
    };
    let post = create_t(&db, &store, &a, "training", "", vec![img], &[vid])
        .await
        .unwrap();
    assert!(!tmp.exists());
    assert_eq!(post.images.len(), 2);
    assert_eq!(
        (post.images[0].media_type.as_str(), post.images[0].sort_order),
        ("image", 0)
    );
    assert_eq!(
        (post.images[1].media_type.as_str(), post.images[1].sort_order),
        ("video", 1)
    );
    assert!(post.images[0].image_url.ends_with(".webp") && post.images[1].image_url.ends_with(".mp4"));

    // Ảnh: Range bị bỏ qua (200); video: 206 đúng khoảng.
    let m0 = mod_newsfeed::media(&db, &store, post.id, 0, Some("bytes=0-9"))
        .await
        .unwrap();
    assert_eq!(m0.object.status(), 200);
    assert_eq!(m0.object.content_type, "image/webp");
    assert!(!m0.is_video);
    let m1 = mod_newsfeed::media(&db, &store, post.id, 1, Some("bytes=10-19"))
        .await
        .unwrap();
    assert_eq!(
        (m1.object.status(), m1.object.len, m1.object.content_range().as_deref()),
        (206, 10, Some("bytes 10-19/1000"))
    );
    assert!(m1.is_video && m1.file_name.ends_with(".mp4"));
    // Ngoài khoảng, âm, bài không có: 404.
    assert_eq!(
        status(mod_newsfeed::media(&db, &store, post.id, 2, None).await.unwrap_err()),
        404
    );
    assert_eq!(
        status(mod_newsfeed::media(&db, &store, post.id, -1, None).await.unwrap_err()),
        404
    );
    assert_eq!(
        status(mod_newsfeed::media(&db, &store, 9999, 0, None).await.unwrap_err()),
        404
    );

    // Xoá bài: tệp rời kho.
    let keys: Vec<String> = post.images.iter().map(|i| i.image_url.clone()).collect();
    let msg = mod_newsfeed::delete(&db, &store, &a, post.id).await.unwrap();
    assert_eq!(json(&msg), serde_json::json!({"message": "Đã xoá bài đăng"}));
    for k in keys {
        assert!(!store.root().join(&k).exists());
    }
    assert_eq!(
        status(mod_newsfeed::media(&db, &store, post.id, 0, None).await.unwrap_err()),
        404
    );

    // Bài cũ chỉ có image_url: vị trí 0 là ảnh, vị trí khác 404.
    store
        .upload("newsfeed/legacy.webp", b"legacy", "image/webp")
        .await
        .unwrap();
    let mut conn = db.acquire().await.unwrap();
    let id: i32 = sqlx::query_scalar("INSERT INTO newsfeed_posts (category, author_id, content, image_url, updated_at) VALUES ('pr', 1, 'c', 'newsfeed/legacy.webp', now()) RETURNING id")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    drop(conn);
    assert_eq!(
        mod_newsfeed::media(&db, &store, id, 0, None).await.unwrap().file_name,
        "legacy.webp"
    );
    assert_eq!(
        status(mod_newsfeed::media(&db, &store, id, 1, None).await.unwrap_err()),
        404
    );
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn danh_sach_phan_trang_thich_va_quyen_sua_xoa() {
    let (db, store) = setup().await;
    let a1 = actor(1, true, false);
    let a2 = actor(2, true, false);
    let admin = actor(4, true, true);
    let mut ids = Vec::new();
    for i in 0..5 {
        let cat = if i % 2 == 0 { "pr" } else { "training" };
        ids.push(
            create_t(&db, &store, &a1, cat, &format!("bài {i}"), vec![], &[])
                .await
                .unwrap()
                .id,
        );
    }
    // Trang 1 (limit 2): id giảm dần, next_cursor là id cuối của trang.
    let p1 = lst(&db, &a2, None, None, Some(2)).await.unwrap();
    assert_eq!(p1.data.iter().map(|p| p.id).collect::<Vec<_>>(), [ids[4], ids[3]]);
    assert_eq!(p1.next_cursor, Some(ids[3]));
    let p2 = lst(&db, &a2, None, p1.next_cursor.map(i64::from), Some(2))
        .await
        .unwrap();
    assert_eq!(p2.data.iter().map(|p| p.id).collect::<Vec<_>>(), [ids[2], ids[1]]);
    let p3 = lst(&db, &a2, None, p2.next_cursor.map(i64::from), Some(2))
        .await
        .unwrap();
    assert_eq!((p3.data.len(), p3.next_cursor), (1, None));
    // Lọc nhóm; limit 1; cursor 0 = trang đầu; cursor không tồn tại = trang trống.
    let pr = lst(&db, &a2, Some("pr"), None, Some(1)).await.unwrap();
    assert_eq!((pr.data.len(), pr.next_cursor), (1, Some(ids[4])));
    assert_eq!(lst(&db, &a2, None, Some(0), None).await.unwrap().data.len(), 5);
    assert!(lst(&db, &a2, None, Some(99_999), None).await.unwrap().data.is_empty());

    // Thích / bỏ thích.
    let l = mod_newsfeed::toggle_like(&db, &a2, ids[4]).await.unwrap();
    assert_eq!(json(&l), serde_json::json!({"liked": true, "like_count": 1}));
    let top = lst(&db, &a2, None, None, Some(1)).await.unwrap();
    assert_eq!((top.data[0].liked_by_me, top.data[0].count.likes), (Some(true), 1));
    let other = lst(&db, &a1, None, None, Some(1)).await.unwrap();
    assert_eq!(other.data[0].liked_by_me, Some(false));
    let l = mod_newsfeed::toggle_like(&db, &a2, ids[4]).await.unwrap();
    assert_eq!((l.liked, l.like_count), (false, 0));
    assert_eq!(
        status(mod_newsfeed::toggle_like(&db, &a2, 9999).await.unwrap_err()),
        404
    );

    // Sửa: tác giả hoặc người kiểm duyệt; người khác 403; có edited_at.
    assert_eq!(
        status(mod_newsfeed::update(&db, &a2, ids[0], "hack").await.unwrap_err()),
        403
    );
    let up = mod_newsfeed::update(&db, &admin, ids[0], "  đã sửa  ").await.unwrap();
    assert_eq!(up.content, "đã sửa");
    assert!(up.edited_at.is_some());
    assert!(json(&up).get("liked_by_me").is_none());
    assert_eq!(
        status(mod_newsfeed::update(&db, &a1, 9999, "x").await.unwrap_err()),
        404
    );
    // Xoá: người khác 403; người kiểm duyệt được.
    assert_eq!(
        status(mod_newsfeed::delete(&db, &store, &a2, ids[1]).await.unwrap_err()),
        403
    );
    mod_newsfeed::delete(&db, &store, &admin, ids[1]).await.unwrap();
    assert_eq!(lst(&db, &a1, None, None, Some(50)).await.unwrap().data.len(), 4);
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn binh_luan() {
    let (db, store) = setup().await;
    let a1 = actor(1, true, false);
    let a2 = actor(2, false, false);
    let admin = actor(4, true, true);
    let post = create_t(&db, &store, &a1, "pr", "p", vec![], &[]).await.unwrap();
    let mut cids = Vec::new();
    for i in 0..3 {
        let c = mod_newsfeed::create_comment(&db, &a2, post.id, &format!(" ý {i} "))
            .await
            .unwrap();
        assert_eq!(
            (c.content.as_str(), c.user.full_name.as_str()),
            (format!("ý {i}").as_str(), "Người 2")
        );
        cids.push(c.id);
    }
    assert_eq!(
        status(mod_newsfeed::create_comment(&db, &a2, 9999, "x").await.unwrap_err()),
        404
    );
    // id tăng dần, trang 2 theo con trỏ.
    let p1 = mod_newsfeed::list_comments(&db, post.id, None, Some(2)).await.unwrap();
    assert_eq!(p1.data.iter().map(|c| c.id).collect::<Vec<_>>(), cids[..2]);
    assert_eq!(p1.next_cursor, Some(cids[1]));
    let p2 = mod_newsfeed::list_comments(&db, post.id, p1.next_cursor.map(i64::from), Some(2))
        .await
        .unwrap();
    assert_eq!((p2.data.len(), p2.next_cursor), (1, None));
    assert_eq!(
        json(&p2.data[0])
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["id", "post_id", "user_id", "content", "created_at", "user"]
    );
    assert_eq!(
        status(mod_newsfeed::list_comments(&db, 9999, None, None).await.unwrap_err()),
        404
    );
    // Đếm bình luận trong bài.
    let top = lst(&db, &a1, None, None, Some(1)).await.unwrap();
    assert_eq!(top.data[0].count.comments, 3);
    // Xoá: người lạ 403, tác giả và người kiểm duyệt được.
    assert_eq!(
        status(mod_newsfeed::delete_comment(&db, &a1, cids[0]).await.unwrap_err()),
        403
    );
    mod_newsfeed::delete_comment(&db, &a2, cids[0]).await.unwrap();
    mod_newsfeed::delete_comment(&db, &admin, cids[1]).await.unwrap();
    assert_eq!(
        status(mod_newsfeed::delete_comment(&db, &admin, cids[1]).await.unwrap_err()),
        404
    );
    // Xoá bài kéo theo bình luận và lượt thích.
    mod_newsfeed::delete(&db, &store, &a1, post.id).await.unwrap();
    let mut conn = db.acquire().await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM newsfeed_post_comments")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn quyen_cua_toi_va_token_video() {
    let p = mod_newsfeed::permissions_me(&actor(1, true, false));
    assert_eq!(json(&p), serde_json::json!({"can_post": true, "can_moderate": false}));
    let e = mod_newsfeed::video_upload_token_gone();
    assert_eq!(e.status(), 400);
}

#[tokio::test]
async fn kiem_query_danh_sach() {
    let ok = mod_newsfeed::validate_list_query(Some("pr"), Some("12"), Some("50")).unwrap();
    assert_eq!(
        (ok.category.as_deref(), ok.cursor, ok.limit),
        (Some("pr"), Some(12), Some(50))
    );
    let empty = mod_newsfeed::validate_list_query(None, None, None).unwrap();
    assert_eq!(empty, mod_newsfeed::ListQuery::default());
    // Ngoài khoảng bị từ chối, không kẹp; câu như class-validator.
    for (c, cur, l, want) in [
        (
            Some("x"),
            None,
            None,
            "category must be one of the following values: announcement, training, pr",
        ),
        (None, None, Some("0"), "limit must not be less than 1"),
        (None, None, Some("51"), "limit must not be greater than 50"),
        (None, None, Some("1.5"), "limit must be an integer number"),
        (None, None, Some("abc"), "limit must be an integer number"),
        (None, Some("x"), None, "cursor must be an integer number"),
    ] {
        match mod_newsfeed::validate_list_query(c, cur, l).unwrap_err() {
            Error::Http(h) => {
                assert_eq!(h.status(), 400);
                let body = serde_json::to_string(&h.body()).unwrap();
                assert!(body.contains(want), "{body} thiếu {want}");
            }
            Error::Internal(m) => panic!("{m}"),
        }
    }
    // Chuỗi rỗng là 0 như `Number("")` (cursor 0 = trang đầu; limit 0 vi phạm tối thiểu).
    assert_eq!(
        mod_newsfeed::validate_list_query(None, Some(""), None).unwrap().cursor,
        Some(0)
    );
    assert!(mod_newsfeed::validate_list_query(None, None, Some("")).is_err());
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn sua_bai_doi_muc_va_them_anh_video() {
    let (db, store) = setup().await;
    let a1 = actor(1, true, false);
    let a2 = actor(2, true, false);
    let admin = actor(4, true, true);
    let png = || ImageUpload {
        content_type: "image/png".into(),
        bytes: PNG.to_vec(),
    };
    let post = create_t(&db, &store, &a1, "announcement", "gốc", vec![png()], &[])
        .await
        .unwrap();

    // Đổi «Mục» qua PATCH: tác giả được; người khác 403; không gửi lại thông báo.
    let before: i64 = {
        let mut c = db.acquire().await.unwrap();
        sqlx::query_scalar("SELECT count(*) FROM notification_logs")
            .fetch_one(&mut *c)
            .await
            .unwrap()
    };
    assert_eq!(
        status(
            mod_newsfeed::update_post(&db, &a2, post.id, "x", Some("pr"))
                .await
                .unwrap_err()
        ),
        403
    );
    let up = mod_newsfeed::update_post(&db, &a1, post.id, "sửa", Some("training"))
        .await
        .unwrap();
    assert_eq!((up.category.as_str(), up.content.as_str()), ("training", "sửa"));
    let kept = mod_newsfeed::update_post(&db, &a1, post.id, "sửa 2", None)
        .await
        .unwrap();
    assert_eq!(kept.category, "training");
    let after: i64 = {
        let mut c = db.acquire().await.unwrap();
        sqlx::query_scalar("SELECT count(*) FROM notification_logs")
            .fetch_one(&mut *c)
            .await
            .unwrap()
    };
    assert_eq!(before, after);

    // Thêm ảnh/video: người khác 403 (không ghi tệp), tác giả và người kiểm duyệt được, nối sau tệp cũ.
    assert_eq!(
        status(
            mod_newsfeed::update_with_media(&db, &store, &a2, post.id, None, None, vec![png()], &[])
                .await
                .unwrap_err()
        ),
        403
    );
    assert_eq!(
        status(
            mod_newsfeed::update_with_media(&db, &store, &a1, post.id, None, None, vec![], &[])
                .await
                .unwrap_err()
        ),
        400
    );
    let tmp = std::env::temp_dir().join(format!("m22-edit-{}.mp4", uuid_like()));
    tokio::fs::write(&tmp, b"video").await.unwrap();
    let vid = VideoUpload {
        file_name: "c.mp4".into(),
        size: 5,
        path: tmp.clone(),
    };
    let up = mod_newsfeed::update_with_media(
        &db,
        &store,
        &a1,
        post.id,
        Some(" có ảnh "),
        Some("pr"),
        vec![png()],
        &[vid],
    )
    .await
    .unwrap();
    assert!(!tmp.exists(), "tệp tạm video phải được dọn");
    assert_eq!((up.category.as_str(), up.content.as_str()), ("pr", "có ảnh"));
    assert!(up.edited_at.is_some());
    let j = json(&up);
    let imgs = j["images"].as_array().unwrap();
    assert_eq!(imgs.len(), 3);
    let orders: Vec<i64> = imgs.iter().map(|m| m["sort_order"].as_i64().unwrap()).collect();
    assert_eq!(orders, [0, 1, 2]);
    assert_eq!(imgs[2]["media_type"], "video");
    let up = mod_newsfeed::update_with_media(&db, &store, &admin, post.id, None, None, vec![png()], &[])
        .await
        .unwrap();
    assert_eq!(up.content, "có ảnh");
    assert_eq!(json(&up)["images"].as_array().unwrap().len(), 4);

    // Trần tính cả tệp đã có: còn 7 chỗ ảnh (đã có 3 ảnh) ⇒ thêm 8 bị chặn, không ghi gì.
    let eight: Vec<ImageUpload> = (0..8).map(|_| png()).collect();
    assert_eq!(
        status(
            mod_newsfeed::update_with_media(&db, &store, &a1, post.id, None, None, eight, &[])
                .await
                .unwrap_err()
        ),
        400
    );
    let n: i64 = {
        let mut c = db.acquire().await.unwrap();
        sqlx::query_scalar("SELECT count(*) FROM newsfeed_post_images WHERE post_id = $1")
            .bind(post.id)
            .fetch_one(&mut *c)
            .await
            .unwrap()
    };
    assert_eq!(n, 4);
    assert_eq!(
        status(
            mod_newsfeed::update_with_media(&db, &store, &a1, 9999, None, None, vec![png()], &[])
                .await
                .unwrap_err()
        ),
        404
    );
}
