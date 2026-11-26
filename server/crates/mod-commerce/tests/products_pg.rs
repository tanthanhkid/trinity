//! M25: sản phẩm, danh mục, thuộc tính trên Postgres thật (`public` đã migrate bằng Prisma, như job Rust pg tests).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-commerce --test products_pg -- --ignored`

use mod_commerce::Actor;
use mod_commerce::attribute_defs::{self, AttributeOption, CreateAttributeDef, UpdateAttributeDef};
use mod_commerce::categories::{self, CreateCategory, UpdateCategory};
use mod_commerce::image::{delete_product_image_file, save_product_image};
use mod_commerce::products::{self, CreateProduct, ListProducts, UpdateProduct};
use mod_commerce::projects::{self, CreateProject};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig, TenantDb};
use trinity_kernel::error::{AppError, Message};
use trinity_storage::LocalUploadsStore;

/// Hai test dùng chung dữ liệu tiền tố `m25`, chạy lần lượt.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn tenant() -> TenantDb {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 3;
    Db::connect(&cfg)
        .await
        .expect("nối DB")
        .tenant(CompanyRef::DEFAULT)
        .await
        .expect("tenant")
}

fn err(e: AppError) -> (u16, String) {
    let (s, b) = e.response(true);
    match b.message {
        Message::One(m) => (s, m),
        Message::Many(m) => (s, m.join("; ")),
    }
}

fn js<T: serde::Serialize>(v: &T) -> Value {
    serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

fn prod(code: &str, name: &str) -> CreateProduct {
    serde_json::from_value(json!({ "code": code, "name": name })).unwrap()
}

async fn clean(c: &mut PgConnection) {
    for sql in [
        "DELETE FROM contacts WHERE code LIKE 'M25%'",
        "DELETE FROM products WHERE code ILIKE 'm25%'",
        "DELETE FROM product_categories WHERE code ILIKE 'm25%'",
        "DELETE FROM projects WHERE code LIKE 'm25_%'",
        "DELETE FROM users WHERE email LIKE 'm25%@test.local'",
    ] {
        sqlx::query(sql).execute(&mut *c).await.unwrap();
    }
}

async fn user(c: &mut PgConnection, n: u8) -> i32 {
    sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, full_name, updated_at) VALUES ($1, 'x', 'M25', now()) RETURNING id",
    )
    .bind(format!("m25{n}@test.local"))
    .fetch_one(c)
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn danh_muc_va_thuoc_tinh() {
    let _serial = SERIAL.lock().await;
    let db = tenant().await;
    let mut c = db.acquire().await.unwrap();
    clean(&mut c).await;
    let uid = user(&mut c, 1).await;

    let cat = categories::create(
        &mut c,
        &serde_json::from_value::<CreateCategory>(
            json!({"code": "m25_Cat", "name": "Nội thất", "description": "mô tả"}),
        )
        .unwrap(),
        uid,
    )
    .await
    .unwrap();
    let j = js(&cat);
    let keys: Vec<_> = j.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "id",
            "code",
            "name",
            "description",
            "is_active",
            "sort_order",
            "created_by",
            "created_at",
            "updated_at"
        ]
    );
    assert_eq!(
        (j["is_active"].clone(), j["sort_order"].clone()),
        (json!(true), json!(0))
    );

    // Mã trùng không phân biệt hoa/thường ⇒ 409 đúng câu.
    let dup = categories::create(
        &mut c,
        &serde_json::from_value(json!({"code": "M25_cat", "name": "Khác"})).unwrap(),
        uid,
    )
    .await
    .unwrap_err();
    assert_eq!(
        err(dup),
        (
            409,
            "Mã danh mục \"M25_cat\" đã tồn tại (trùng \"m25_Cat\", không phân biệt hoa/thường)".into()
        )
    );

    // PATCH: description null xoá, vắng giữ nguyên; tắt danh mục.
    let u = categories::update(
        &mut c,
        cat.id,
        &serde_json::from_value(json!({"description": null})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!((u.description.clone(), u.name.as_str()), (None, "Nội thất"));
    let u = categories::update(
        &mut c,
        cat.id,
        &UpdateCategory {
            is_active: Some(false),
            sort_order: Some(5),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(!u.is_active && u.sort_order == 5 && u.code == "m25_Cat");
    assert!(
        !categories::find_all(&mut c, false)
            .await
            .unwrap()
            .iter()
            .any(|x| x.id == cat.id)
    );
    assert!(
        categories::find_all(&mut c, true)
            .await
            .unwrap()
            .iter()
            .any(|x| x.id == cat.id)
    );
    assert_eq!(
        err(categories::find_one(&mut c, i32::MAX).await.unwrap_err()),
        (404, "Danh mục sản phẩm không tồn tại".into())
    );
    assert_eq!(
        err(categories::update(&mut c, i32::MAX, &UpdateCategory::default())
            .await
            .unwrap_err()),
        (404, "Danh mục sản phẩm không tồn tại".into())
    );

    // Thuộc tính động.
    assert_eq!(
        err(attribute_defs::create(
            &mut c,
            i32::MAX,
            &serde_json::from_value(json!({"key": "a", "label": "A", "type": "text"})).unwrap()
        )
        .await
        .unwrap_err()),
        (400, format!("Danh mục sản phẩm ID {} không tồn tại", i32::MAX))
    );
    let d = attribute_defs::create(
        &mut c,
        cat.id,
        &serde_json::from_value(json!({"key": "mat", "label": "Chất liệu", "type": "text", "is_required": true}))
            .unwrap(),
    )
    .await
    .unwrap();
    let dj = js(&d);
    let keys: Vec<_> = dj.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "id",
            "category_id",
            "key",
            "label",
            "type",
            "options",
            "is_required",
            "sort_order",
            "created_at",
            "updated_at"
        ]
    );
    assert_eq!(dj["options"], Value::Null);
    assert_eq!(
        err(attribute_defs::create(
            &mut c,
            cat.id,
            &serde_json::from_value(json!({"key": "mat", "label": "X", "type": "text"})).unwrap()
        )
        .await
        .unwrap_err()),
        (409, "Thuộc tính key \"mat\" đã tồn tại trong danh mục này".into())
    );
    let sel_err = "Thuộc tính kiểu select/multiselect phải có ít nhất một lựa chọn (options)";
    assert_eq!(
        err(attribute_defs::create(
            &mut c,
            cat.id,
            &serde_json::from_value(json!({"key": "mau", "label": "Màu", "type": "select"})).unwrap()
        )
        .await
        .unwrap_err()),
        (400, sel_err.into())
    );
    let sel = attribute_defs::create(
        &mut c,
        cat.id,
        &CreateAttributeDef {
            key: "mau".into(),
            label: "Màu".into(),
            r#type: "select".into(),
            options: Some(vec![AttributeOption {
                value: "do".into(),
                label: "Đỏ".into(),
            }]),
            is_required: None,
            sort_order: Some(2),
        },
    )
    .await
    .unwrap();
    assert_eq!(js(&sel)["options"], json!([{"value": "do", "label": "Đỏ"}]));
    // Sửa theo trạng thái SAU khi sửa: xoá options của def đang là select ⇒ 400; đổi sang text rồi xoá options được.
    assert_eq!(
        err(attribute_defs::update(
            &mut c,
            sel.id,
            &serde_json::from_value(json!({"options": null})).unwrap()
        )
        .await
        .unwrap_err()),
        (400, sel_err.into())
    );
    let t = attribute_defs::update(
        &mut c,
        sel.id,
        &serde_json::from_value(json!({"type": "text", "options": null, "label": "Màu sắc"})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        (t.r#type.as_str(), t.label.as_str(), t.options.is_none()),
        ("text", "Màu sắc", true)
    );
    assert_eq!(
        err(attribute_defs::update(
            &mut c,
            sel.id,
            &serde_json::from_value(json!({"type": "multiselect"})).unwrap()
        )
        .await
        .unwrap_err()),
        (400, sel_err.into())
    );
    let all = attribute_defs::find_all_for_category(&mut c, cat.id).await.unwrap();
    assert_eq!(all.iter().map(|x| x.key.as_str()).collect::<Vec<_>>(), ["mat", "mau"]);
    attribute_defs::remove(&mut c, sel.id).await.unwrap();
    assert_eq!(
        err(attribute_defs::remove(&mut c, sel.id).await.unwrap_err()),
        (404, "Thuộc tính không tồn tại".into())
    );
    assert_eq!(
        err(attribute_defs::update(&mut c, i32::MAX, &UpdateAttributeDef::default())
            .await
            .unwrap_err()),
        (404, "Thuộc tính không tồn tại".into())
    );
    clean(&mut c).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn san_pham_vong_doi() {
    let _serial = SERIAL.lock().await;
    let db = tenant().await;
    let mut c = db.acquire().await.unwrap();
    clean(&mut c).await;
    let (admin_id, sale_id) = (user(&mut c, 1).await, user(&mut c, 2).await);
    let admin = Actor {
        user_id: admin_id,
        is_admin: true,
    };
    let sale = Actor {
        user_id: sale_id,
        is_admin: false,
    };

    let proj = projects::create(
        &mut c,
        &CreateProject {
            name: "P".into(),
            code: "m25_p".into(),
            color: None,
        },
        admin_id,
    )
    .await
    .unwrap();
    let cat = categories::create(
        &mut c,
        &serde_json::from_value(json!({"code": "M25C", "name": "Cat"})).unwrap(),
        admin_id,
    )
    .await
    .unwrap();
    for def in [
        json!({"key": "mat", "label": "Chất liệu", "type": "text", "is_required": true}),
        json!({"key": "bh", "label": "Bảo hành", "type": "number", "sort_order": 1}),
    ] {
        attribute_defs::create(&mut c, cat.id, &serde_json::from_value(def).unwrap())
            .await
            .unwrap();
    }

    // Tạo: JSON đúng thứ tự khoá, price là số, attributes chuẩn hoá ("12" → 12).
    let mut input = prod("M25-A", "Ghế");
    input.project_id = Some(proj.id);
    input.category_id = Some(cat.id);
    input.attributes = Some(json!({"bh": "12", "mat": "Gỗ"}));
    input.price = Some(500_000);
    input.tags = Some(vec!["a".into(), "b".into()]);
    let a = products::create(&mut c, &input, admin_id).await.unwrap();
    let j = js(&a);
    let keys: Vec<_> = j.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "id",
            "code",
            "name",
            "project_id",
            "brand",
            "color",
            "tags",
            "is_featured",
            "image_url",
            "category_id",
            "attributes",
            "description",
            "price",
            "is_active",
            "created_by",
            "created_at",
            "updated_at"
        ]
    );
    assert_eq!(j["price"], json!(500_000));
    assert_eq!(j["tags"], json!(["a", "b"]));
    assert_eq!(j["attributes"]["bh"], json!(12));
    assert_eq!(j["attributes"]["mat"], json!("Gỗ"));

    // Không gán danh mục ⇒ price null giữ null, attributes {}.
    let b = products::create(&mut c, &prod("M25-B", "Bàn"), admin_id).await.unwrap();
    let jb = js(&b);
    assert_eq!(
        (jb["price"].clone(), jb["attributes"].clone(), jb["tags"].clone()),
        (Value::Null, json!({}), json!([]))
    );

    // Lỗi tạo, đúng thứ tự kiểm.
    let e = |r: Result<products::Product, AppError>| err(r.unwrap_err());
    assert_eq!(
        e(products::create(&mut c, &prod("m25-a", "Dup"), admin_id).await),
        (
            409,
            "Mã sản phẩm \"m25-a\" đã tồn tại (trùng \"M25-A\", không phân biệt hoa/thường)".into()
        )
    );
    let mut bad = prod("M25-C", "x");
    bad.project_id = Some(i32::MAX);
    assert_eq!(
        e(products::create(&mut c, &bad, admin_id).await),
        (400, format!("Dự án ID {} không tồn tại", i32::MAX))
    );
    projects::update(
        &mut c,
        proj.id,
        &serde_json::from_value(json!({"is_active": false})).unwrap(),
    )
    .await
    .unwrap();
    bad.project_id = Some(proj.id);
    assert_eq!(
        e(products::create(&mut c, &bad, admin_id).await),
        (400, "Dự án \"P\" đã ngưng hoạt động".into())
    );
    let mut bad = prod("M25-C", "x");
    bad.attributes = Some(json!({"zz": 1}));
    assert_eq!(
        e(products::create(&mut c, &bad, admin_id).await),
        (
            400,
            "Sản phẩm chưa gán danh mục (hoặc danh mục chưa có thuộc tính nào) — không thể nhập attributes".into()
        )
    );
    bad.attributes = None;
    bad.category_id = Some(cat.id);
    assert_eq!(
        e(products::create(&mut c, &bad, admin_id).await),
        (400, "Thuộc tính \"Chất liệu\" là bắt buộc".into())
    );
    categories::update(
        &mut c,
        cat.id,
        &UpdateCategory {
            is_active: Some(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        e(products::create(&mut c, &bad, admin_id).await),
        (400, "Danh mục \"Cat\" đã ngưng hoạt động".into())
    );
    categories::update(
        &mut c,
        cat.id,
        &UpdateCategory {
            is_active: Some(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    // Sửa: price null xoá; đổi category_id về null khi attributes còn giá trị ⇒ 400; kèm attributes {} thì được.
    let u = products::update(
        &mut c,
        a.id,
        &serde_json::from_value(json!({"price": null, "name": "Ghế 2", "is_featured": true})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        (u.price, u.name.as_str(), u.is_featured, u.tags.0.clone()),
        (None, "Ghế 2", true, vec!["a".to_owned(), "b".to_owned()])
    );
    assert_eq!(
        e(products::update(
            &mut c,
            a.id,
            &serde_json::from_value(json!({"category_id": null})).unwrap()
        )
        .await),
        (
            400,
            "Sản phẩm chưa gán danh mục (hoặc danh mục chưa có thuộc tính nào) — không thể nhập attributes".into()
        )
    );
    let u = products::update(
        &mut c,
        a.id,
        &serde_json::from_value(json!({"category_id": null, "attributes": null})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!((u.category_id, js(&u)["attributes"].clone()), (None, json!({})));
    assert_eq!(
        e(products::update(&mut c, i32::MAX, &UpdateProduct::default()).await),
        (404, "Sản phẩm không tồn tại".into())
    );
    assert_eq!(js(&u)["code"], json!("M25-A"));
    assert_eq!(u.project_id, Some(proj.id), "project_id không đổi được");

    // Danh sách: nổi bật trước; lọc; `q` không phân biệt hoa/thường theo tên/mã/brand; archived chỉ Quản trị.
    let list = products::find_all(
        &mut c,
        &ListProducts {
            q: Some("m25".into()),
            ..Default::default()
        },
        sale,
    )
    .await
    .unwrap();
    assert_eq!(
        list.iter().map(|p| p.code.as_str()).collect::<Vec<_>>(),
        ["M25-A", "M25-B"]
    );
    let list = products::find_all(
        &mut c,
        &ListProducts {
            q: Some("bàn".into()),
            is_active: Some(true),
            ..Default::default()
        },
        sale,
    )
    .await
    .unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(
        err(products::find_all(
            &mut c,
            &ListProducts {
                archived: Some(true),
                ..Default::default()
            },
            sale
        )
        .await
        .unwrap_err()),
        (403, "Chỉ Quản trị mới xem được sản phẩm đã xoá".into())
    );

    // Xoá mềm: lần hai 404; ẩn khỏi đọc thường; mã còn bị giữ; chỉ chủ xoá/Quản trị khôi phục.
    assert_eq!(
        products::remove(&mut c, b.id, sale).await.unwrap(),
        products::Archived {
            id: b.id,
            archived: true
        }
    );
    assert_eq!(
        err(products::remove(&mut c, b.id, admin).await.unwrap_err()),
        (404, "Sản phẩm không tồn tại".into())
    );
    assert_eq!(
        e(products::find_one(&mut c, b.id).await),
        (404, "Sản phẩm không tồn tại".into())
    );
    let arch = products::find_all(
        &mut c,
        &ListProducts {
            archived: Some(true),
            q: Some("M25-B".into()),
            ..Default::default()
        },
        admin,
    )
    .await
    .unwrap();
    assert_eq!(arch.len(), 1);
    assert_eq!(
        e(products::create(&mut c, &prod("M25-B", "again"), admin_id).await).0,
        409
    );
    assert!(
        err(products::create(&mut c, &prod("M25-B", "again"), admin_id)
            .await
            .unwrap_err())
        .1
        .contains("đang thuộc một sản phẩm đã xoá")
    );
    let other = Actor {
        user_id: sale_id + 1000,
        is_admin: false,
    };
    assert_eq!(
        err(products::restore(&mut c, b.id, other).await.unwrap_err()),
        (
            403,
            "Chỉ người đã xoá hoặc Quản trị mới khôi phục được sản phẩm này".into()
        )
    );
    assert_eq!(products::restore(&mut c, b.id, sale).await.unwrap().id, b.id);
    assert_eq!(
        err(products::restore(&mut c, b.id, sale).await.unwrap_err()),
        (404, "Không có sản phẩm đang chờ khôi phục".into())
    );
    // Quá 10 phút ⇒ 410.
    products::remove(&mut c, b.id, sale).await.unwrap();
    sqlx::query("UPDATE products SET deleted_at = now() - interval '11 minutes' WHERE id = $1")
        .bind(b.id)
        .execute(&mut *c)
        .await
        .unwrap();
    assert_eq!(
        err(products::restore(&mut c, b.id, admin).await.unwrap_err()),
        (
            410,
            "Đã quá thời gian hoàn tác — sản phẩm vẫn nằm trong mục đã xoá".into()
        )
    );
    let body = products::restore(&mut c, b.id, admin)
        .await
        .unwrap_err()
        .response(true)
        .1;
    assert_eq!(body.error, "Gone");

    // Xoá hẳn: chỉ Quản trị; liên hệ trỏ tới ⇒ 409; ảnh dùng chung không bị xoá file.
    let dir = std::env::temp_dir().join(format!("m25_{}", std::process::id()));
    let store = LocalUploadsStore::new(&dir);
    let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
    let url = save_product_image(&store, db.company(), Some(&png)).await.unwrap();
    assert!(url.starts_with("/uploads/products/") && url.ends_with(".png"), "{url}");
    let file = dir.join(url.trim_start_matches("/uploads/"));
    assert!(file.exists());
    let (p1, p2) = (
        a.id,
        products::create(&mut c, &prod("M25-D", "D"), admin_id)
            .await
            .unwrap()
            .id,
    );
    for id in [p1, p2] {
        products::update(&mut c, id, &serde_json::from_value(json!({"image_url": url})).unwrap())
            .await
            .unwrap();
    }
    assert_eq!(
        err(products::purge(&db, &store, p1, sale).await.unwrap_err()),
        (403, "Chỉ Quản trị mới xoá hẳn được sản phẩm".into())
    );
    sqlx::query("INSERT INTO contacts (code, phone, full_name, custom_fields, updated_at, product_id) VALUES ('M25-K', '0900000001', 'K', '[]', now(), $1)")
        .bind(p1)
        .execute(&mut *c)
        .await
        .unwrap();
    assert_eq!(
        err(products::purge(&db, &store, p1, admin).await.unwrap_err()),
        (
            409,
            "Sản phẩm đã có trong 1 liên hệ — không thể xoá hẳn, chỉ có thể ẩn".into()
        )
    );
    sqlx::query("DELETE FROM contacts WHERE code = 'M25-K'")
        .execute(&mut *c)
        .await
        .unwrap();
    assert_eq!(
        products::purge(&db, &store, p1, admin).await.unwrap(),
        products::Purged { id: p1, deleted: true }
    );
    assert!(file.exists(), "p2 còn dùng ảnh");
    assert_eq!(
        err(products::purge(&db, &store, p1, admin).await.unwrap_err()),
        (404, "Sản phẩm không tồn tại".into())
    );
    products::purge(&db, &store, p2, admin).await.unwrap();
    assert!(!file.exists(), "hết sản phẩm dùng ảnh thì xoá file");
    assert!(!delete_product_image_file(&store, db.company(), Some("https://x/uploads/products/a.png")).await);
    assert_eq!(
        err(save_product_image(&store, db.company(), Some(b"<svg/>"))
            .await
            .unwrap_err()),
        (
            400,
            "Định dạng ảnh không hợp lệ. Chỉ chấp nhận JPG, PNG, WebP, GIF.".into()
        )
    );
    assert_eq!(
        err(save_product_image(&store, db.company(), None).await.unwrap_err()),
        (400, "Vui lòng chọn ảnh để tải lên".into())
    );
    let big = vec![0xff; 5 * 1024 * 1024 + 1];
    assert_eq!(
        err(save_product_image(&store, db.company(), Some(&big)).await.unwrap_err()),
        (400, "Ảnh quá lớn: 5.0MB. Tối đa 5MB.".into())
    );
    std::fs::remove_dir_all(&dir).ok();
    clean(&mut c).await;
}
