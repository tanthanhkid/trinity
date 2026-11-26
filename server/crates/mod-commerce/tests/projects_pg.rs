//! M28: dự án trên Postgres thật (`public` đã migrate bằng Prisma, như job Rust pg tests của CI).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-commerce --test projects_pg -- --ignored`

use mod_commerce::projects::{CreateProject, UpdateProject, create, find_all, find_one, remove, update};
use trinity_db::{CompanyRef, Db, DbConfig};

async fn conn() -> trinity_db::TenantConn {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 2;
    let db = Db::connect(&cfg).await.expect("nối DB");
    db.tenant(CompanyRef::DEFAULT)
        .await
        .expect("tenant")
        .acquire()
        .await
        .expect("acquire")
}

fn status(e: trinity_kernel::error::AppError) -> (u16, String) {
    let (s, b) = e.response(true);
    (s, serde_json::to_string(&b.message).unwrap())
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn vong_doi_du_an() {
    let mut c = conn().await;
    sqlx::query("DELETE FROM projects WHERE code LIKE 'm28\\_%'")
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE email = 'm28@test.local'")
        .execute(&mut *c)
        .await
        .unwrap();
    let uid: i32 = sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, full_name, updated_at) VALUES ('m28@test.local', 'x', 'M28', now()) RETURNING id",
    )
    .fetch_one(&mut *c)
    .await
    .unwrap();

    // Tạo: color vắng ⇒ null, is_active mặc định true; khoá JSON đúng thứ tự `toProjectDto`.
    let p = create(
        &mut c,
        &CreateProject {
            name: "Bán lẻ".into(),
            code: "m28_retail".into(),
            color: None,
        },
        uid,
    )
    .await
    .expect("tạo");
    let json: serde_json::Value = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
    let keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "id",
            "name",
            "code",
            "color",
            "is_active",
            "created_by",
            "created_at",
            "updated_at"
        ]
    );
    assert_eq!(json["color"], serde_json::Value::Null);
    assert_eq!(json["is_active"], true);
    assert_eq!(json["created_by"], uid);
    assert!(json["created_at"].as_str().unwrap().ends_with('Z'));

    // Mã trùng ⇒ 409 đúng câu.
    let dup = create(
        &mut c,
        &CreateProject {
            name: "Khác".into(),
            code: "m28_retail".into(),
            color: Some("red".into()),
        },
        uid,
    )
    .await
    .unwrap_err();
    assert_eq!(status(dup), (409, "\"Mã dự án đã tồn tại\"".into()));

    // Sửa: tên đổi, color vắng giữ nguyên; color null xoá; is_active tắt.
    let upd = update(
        &mut c,
        p.id,
        &UpdateProject {
            name: Some("Bán lẻ 2".into()),
            color: Some(Some("blue".into())),
            is_active: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        (upd.name.as_str(), upd.color.as_deref(), upd.is_active),
        ("Bán lẻ 2", Some("blue"), true)
    );
    assert!(upd.updated_at >= p.updated_at);
    let keep = update(&mut c, p.id, &serde_json::from_str(r#"{"is_active":true}"#).unwrap())
        .await
        .unwrap();
    assert_eq!(keep.color.as_deref(), Some("blue"));
    let cleared = update(&mut c, p.id, &serde_json::from_str(r#"{"color":null}"#).unwrap())
        .await
        .unwrap();
    assert_eq!(cleared.color, None);
    assert_eq!(cleared.code, "m28_retail");

    // Xoá mềm: còn đọc được, ẩn khỏi danh sách mặc định, hiện khi include_inactive.
    let gone = remove(&mut c, p.id).await.unwrap();
    assert!(!gone.is_active);
    assert!(!find_one(&mut c, p.id).await.unwrap().is_active);
    assert!(!find_all(&mut c, false).await.unwrap().iter().any(|x| x.id == p.id));
    assert!(find_all(&mut c, true).await.unwrap().iter().any(|x| x.id == p.id));

    // 404 cho id không có (find_one, update, remove).
    for e in [
        find_one(&mut c, i32::MAX).await.unwrap_err(),
        update(&mut c, i32::MAX, &UpdateProject::default()).await.unwrap_err(),
        remove(&mut c, i32::MAX).await.unwrap_err(),
    ] {
        assert_eq!(status(e), (404, "\"Dự án không tồn tại\"".into()));
    }

    // Mới nhất trước.
    let q = create(
        &mut c,
        &CreateProject {
            name: "Hai".into(),
            code: "m28_two".into(),
            color: None,
        },
        uid,
    )
    .await
    .unwrap();
    let all = find_all(&mut c, true).await.unwrap();
    let pos = |id| all.iter().position(|x| x.id == id).unwrap();
    assert!(pos(q.id) < pos(p.id));

    sqlx::query("DELETE FROM projects WHERE code LIKE 'm28\\_%'")
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(uid)
        .execute(&mut *c)
        .await
        .unwrap();
}
