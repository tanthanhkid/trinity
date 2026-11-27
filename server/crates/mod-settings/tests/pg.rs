//! M06 với Postgres thật. Cần DB riêng đã có schema (migrate bằng Prisma hoặc `psql -f server/contracts/schema.sql`); các bảng
//! `settings`, `setting_options`, `audit_logs`, `users` bị TRUNCATE:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-settings --test pg -- --ignored --test-threads=1`

use mod_settings::features::{self, PLAN_SETTING_KEY};
use mod_settings::general;
use mod_settings::options;
use mod_settings::{
    Ctx, QueryOptions, validate_create_option, validate_org_features, validate_plan_body, validate_query_options,
    validate_update_option, verify_plan_token,
};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_kernel::error::AppError;
use trinity_rbac::plan::PlanKey;

const SINGLE: Ctx = Ctx { company_id: None };
const COMPANY_2: Ctx = Ctx { company_id: Some(2) };

async fn setup() -> PgConnection {
    let mut c = PgConnection::connect(&std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL"))
        .await
        .expect("kết nối DB");
    exec(
        &mut c,
        "TRUNCATE settings, setting_options, audit_logs, users RESTART IDENTITY CASCADE",
    )
    .await;
    c
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

async fn scalar(c: &mut PgConnection, sql: &str) -> String {
    sqlx::query_scalar::<_, Option<String>>(AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut *c)
        .await
        .unwrap()
        .unwrap_or_else(|| "<NULL>".to_owned())
}

fn js<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap()
}

fn expect_err<T: std::fmt::Debug>(r: Result<T, AppError>, code: u16, text: &str) {
    match r.unwrap_err() {
        AppError::Http(h) => {
            let body = serde_json::to_string(&h.body()).unwrap();
            assert_eq!(h.status(), code, "{body}");
            assert!(body.contains(text), "{body} thiếu {text}");
        }
        other => panic!("lỗi không phải HTTP: {other:?}"),
    }
}

fn create(v: Value) -> mod_settings::CreateOption {
    validate_create_option(&v).unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn tuy_chon_tao_sua_xoa_mem() {
    let mut c = setup().await;
    exec(&mut c, "INSERT INTO setting_options (group_key, value, label, sort_order, is_system, updated_at) VALUES \
        ('contact_source', 'web', 'Website', 2, true, now()), ('contact_source', 'ads', 'Quảng cáo', 1, false, now()), ('contact_stage', 'new', 'Mới', 0, true, now())").await;

    // Danh sách: nhóm trước, sort_order rồi id; lọc theo nhóm.
    let all = options::list(&mut c, &validate_query_options(&json!({})).unwrap())
        .await
        .unwrap();
    assert_eq!(
        all.data.iter().map(|o| o.value.as_str()).collect::<Vec<_>>(),
        ["ads", "web", "new"]
    );
    assert_eq!(
        js(&all.data[0]),
        r#"{"id":2,"group_key":"contact_source","value":"ads","label":"Quảng cáo","sort_order":1,"is_active":true,"is_system":false,"metadata":null}"#
    );
    let one = options::list(
        &mut c,
        &validate_query_options(&json!({"group": "contact_stage"})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(one.data.len(), 1);

    // Tạo: mặc định, metadata vắng lưu JSON null (không phải SQL NULL).
    let made = options::create(
        &mut c,
        &create(json!({"group_key": "contact_source", "value": "ref", "label": "Giới thiệu"})),
        9,
    )
    .await
    .unwrap();
    assert_eq!((made.sort_order, made.is_active, made.is_system), (0, true, false));
    assert_eq!(
        scalar(
            &mut c,
            &format!("SELECT metadata::text FROM setting_options WHERE id = {}", made.id)
        )
        .await,
        "null"
    );
    assert_eq!(
        scalar(
            &mut c,
            &format!("SELECT updated_by::text FROM setting_options WHERE id = {}", made.id)
        )
        .await,
        "9"
    );
    let with_meta = options::create(&mut c, &create(json!({"group_key": "g_x", "value": "v1", "label": "L", "sort_order": 5, "is_active": false, "metadata": {"color": "red"}})), 9).await.unwrap();
    assert_eq!(
        (with_meta.sort_order, with_meta.is_active, js(&with_meta.metadata)),
        (5, false, r##"{"color":"red"}"##.to_owned())
    );

    // Trùng (group_key, value) ⇒ 409 đúng câu.
    expect_err(
        options::create(
            &mut c,
            &create(json!({"group_key": "contact_source", "value": "ref", "label": "x"})),
            9,
        )
        .await,
        409,
        "Giá trị \\\"ref\\\" đã tồn tại trong nhóm \\\"contact_source\\\"",
    );
    // Dữ liệu sai bị bộ kiểm chung chặn trước khi tới DB.
    assert!(validate_create_option(&json!({"group_key": "Sai Nhom", "value": "v", "label": "l"})).is_err());

    // Sửa: chỉ label/sort_order/is_active/metadata; group_key và value không đổi được (khoá lạ bị chặn ở validate).
    let upd = validate_update_option(&json!({"label": "Nhãn mới", "sort_order": 3})).unwrap();
    let u = options::update(&mut c, made.id, &upd, 4).await.unwrap();
    assert_eq!(
        (u.label.as_str(), u.sort_order, u.value.as_str()),
        ("Nhãn mới", 3, "ref")
    );
    assert_eq!(
        scalar(
            &mut c,
            &format!("SELECT updated_by::text FROM setting_options WHERE id = {}", made.id)
        )
        .await,
        "4"
    );
    assert!(validate_update_option(&json!({"value": "doi"})).is_err());
    // metadata: đặt rồi `null` đặt lại JSON null; không gửi thì giữ nguyên.
    options::update(
        &mut c,
        made.id,
        &validate_update_option(&json!({"metadata": {"a": 1}})).unwrap(),
        4,
    )
    .await
    .unwrap();
    let kept = options::update(
        &mut c,
        made.id,
        &validate_update_option(&json!({"label": "L2"})).unwrap(),
        4,
    )
    .await
    .unwrap();
    assert_eq!(js(&kept.metadata), r#"{"a":1}"#);
    let cleared = options::update(
        &mut c,
        made.id,
        &validate_update_option(&json!({"metadata": null})).unwrap(),
        4,
    )
    .await
    .unwrap();
    assert_eq!(cleared.metadata, Value::Null);
    assert_eq!(
        scalar(
            &mut c,
            &format!("SELECT metadata::text FROM setting_options WHERE id = {}", made.id)
        )
        .await,
        "null"
    );
    expect_err(
        options::update(&mut c, 9999, &UpdateOptionDefault::default(), 4).await,
        404,
        "Không tìm thấy option ID 9999",
    );

    // Xoá mềm: hệ thống ⇒ 400; thường ⇒ is_active=false, danh sách mặc định không còn, `active=false` thì còn.
    expect_err(
        options::remove(&mut c, 1, 4).await,
        400,
        "Không xoá được giá trị hệ thống (is_system=true)",
    );
    let removed = options::remove(&mut c, made.id, 4).await.unwrap();
    assert_eq!(js(&removed), format!(r#"{{"deleted":true,"id":{}}}"#, made.id));
    assert_eq!(
        options::remove(&mut c, made.id, 4).await.unwrap(),
        removed,
        "xoá lại vẫn thành công"
    );
    let active = options::list(
        &mut c,
        &QueryOptions {
            group: Some("contact_source".into()),
            active: None,
        },
    )
    .await
    .unwrap();
    assert!(active.data.iter().all(|o| o.value != "ref"));
    let hidden = options::list(
        &mut c,
        &validate_query_options(&json!({"group": "contact_source", "active": "false"})).unwrap(),
    )
    .await
    .unwrap();
    assert!(hidden.data.iter().any(|o| o.value == "ref" && !o.is_active));
    expect_err(
        options::remove(&mut c, 9999, 4).await,
        404,
        "Không tìm thấy option ID 9999",
    );
}

type UpdateOptionDefault = mod_settings::UpdateOption;

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn am_bao_va_phong_ban() {
    let mut c = setup().await;
    assert_eq!(
        js(&general::get_notification_sound(&mut c).await),
        r#"{"sound_id":"beep"}"#
    );
    expect_err(
        general::update_notification_sound(&mut c, "khong-co", 3).await,
        400,
        "sound_id không hợp lệ. Cho phép: beep, ding-dong",
    );
    assert_eq!(
        general::update_notification_sound(&mut c, "harp", 3)
            .await
            .unwrap()
            .sound_id,
        "harp"
    );
    assert_eq!(general::get_notification_sound(&mut c).await.sound_id, "harp");
    assert_eq!(
        scalar(
            &mut c,
            "SELECT updated_by::text FROM settings WHERE key = 'notification_sound_id'"
        )
        .await,
        "3"
    );
    exec(
        &mut c,
        "UPDATE settings SET value = 'rac' WHERE key = 'notification_sound_id'",
    )
    .await;
    assert_eq!(
        general::get_notification_sound(&mut c).await.sound_id,
        "beep",
        "giá trị rác ⇒ mặc định"
    );

    // Phòng ban: mặc định, làm sạch (cắt khoảng trắng, bỏ rỗng, bỏ trùng không phân biệt hoa thường), lưu đúng JSON.
    assert_eq!(general::get_departments(&mut c).await.departments.len(), 7);
    let input = vec![
        json!("  Kinh doanh "),
        json!("kinh DOANH"),
        json!(""),
        json!(5),
        json!("Kế toán"),
        json!("   "),
    ];
    let d = general::update_departments(&mut c, &input, 3).await.unwrap();
    assert_eq!(d.departments, ["Kinh doanh", "Kế toán"]);
    assert_eq!(
        scalar(&mut c, "SELECT value FROM settings WHERE key = 'department_list'").await,
        r#"["Kinh doanh","Kế toán"]"#
    );
    assert_eq!(
        general::get_departments(&mut c).await.departments,
        ["Kinh doanh", "Kế toán"]
    );
    // Cắt 100 ký tự, tối đa 50 mục.
    let many: Vec<Value> = (0..60).map(|i| json!(format!("P{i}{}", "x".repeat(120)))).collect();
    let capped = general::update_departments(&mut c, &many, 3).await.unwrap();
    assert_eq!(capped.departments.len(), 50);
    assert!(capped.departments.iter().all(|n| n.chars().count() <= 100));
    expect_err(
        general::update_departments(&mut c, &[json!(" "), json!(7)], 3).await,
        400,
        "Danh sách phòng ban không được rỗng",
    );
    exec(
        &mut c,
        "UPDATE settings SET value = '{\"a\":1}' WHERE key = 'department_list'",
    )
    .await;
    assert_eq!(
        general::get_departments(&mut c).await.departments.len(),
        7,
        "JSON rác ⇒ mặc định"
    );
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn tinh_nang_goi_va_muc_dung() {
    let mut c = setup().await;
    exec(&mut c, "INSERT INTO users (id, email, password_hash, full_name, status, updated_at, deleted_at) VALUES \
        (1, 'a@x.vn', 'x', 'A', 'active', now(), NULL), (2, 'b@x.vn', 'x', 'B', 'active', now(), now()), (3, 'c@x.vn', 'x', 'C', 'locked', now(), NULL), (4, 'd@x.vn', 'x', 'D', 'active', now(), NULL)").await;
    // Bản một công ty: gói mặc định `custom` (không giới hạn); chưa lưu gì ⇒ bật hết trừ `online_store`.
    assert_eq!(features::get_plan(&mut c, SINGLE).await, PlanKey::Custom);
    let f = features::get(&mut c, SINGLE).await.unwrap();
    let json = js(&f);
    assert!(
        json.starts_with(r#"{"dashboard":true,"contacts":true,"kanban":true,"reports":true,"inbox":true"#),
        "{json}"
    );
    assert!(json.contains(r#""online_store":false"#));
    // Công ty 2 chưa có dòng gói ⇒ gói đăng ký mặc định.
    assert_eq!(features::get_plan(&mut c, COMPANY_2).await, PlanKey::MacDinh);

    // Cập nhật một phần giữ nguyên khoá vắng; khoá đã gỡ nhận rồi bỏ qua; lưu đúng thứ tự khoá.
    let upd = validate_org_features(&json!({"kanban": false, "payments": true, "google_sheets": false})).unwrap();
    let after = features::update(&mut c, SINGLE, &upd, 3).await.unwrap();
    assert!(js(&after).contains(r#""kanban":false"#) && !js(&after).contains("payments"));
    let stored = scalar(&mut c, "SELECT value FROM settings WHERE key = 'org_features'").await;
    assert!(
        stored.starts_with(r#"{"dashboard":true,"contacts":true,"kanban":false,"reports":true"#),
        "{stored}"
    );
    assert_eq!(
        scalar(
            &mut c,
            "SELECT updated_by::text FROM settings WHERE key = 'org_features'"
        )
        .await,
        "3"
    );
    features::update(
        &mut c,
        SINGLE,
        &validate_org_features(&json!({"pos": false})).unwrap(),
        3,
    )
    .await
    .unwrap();
    let again = js(&features::get(&mut c, SINGLE).await.unwrap());
    assert!(again.contains(r#""kanban":false"#) && again.contains(r#""pos":false"#));

    // Gói `ket_noi` không có cờ theo gói: bật ⇒ 400, và đọc luôn bị hạ về tắt.
    features::set_plan(&mut c, SINGLE, PlanKey::KetNoi, Some(3), "api", Some("10.0.0.1"))
        .await
        .unwrap();
    expect_err(
        features::update(
            &mut c,
            SINGLE,
            &validate_org_features(&json!({"zalo_oa": true})).unwrap(),
            3,
        )
        .await,
        400,
        "Gói \\\"Kết nối\\\" không có tính năng này. Nâng gói để bật.",
    );
    let gated = js(&features::get(&mut c, SINGLE).await.unwrap());
    for k in [
        "ai_briefing",
        "zalo_oa",
        "lead_scoring",
        "stale_reminders",
        "facebook_page",
    ] {
        assert!(gated.contains(&format!("\"{k}\":false")), "{k} {gated}");
    }
    // Tắt một cờ theo gói thì vẫn được (chỉ BẬT mới bị chặn).
    features::update(
        &mut c,
        SINGLE,
        &validate_org_features(&json!({"zalo_oa": false})).unwrap(),
        3,
    )
    .await
    .unwrap();

    // Đổi gói ghi nhật ký trong cùng lượt: from, to, source, ip.
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_logs WHERE resource = 'org_plan'")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(n, 1);
    assert_eq!(
        scalar(
            &mut c,
            "SELECT metadata::text FROM audit_logs WHERE resource = 'org_plan'"
        )
        .await,
        r#"{"to": "ket_noi", "from": "custom", "source": "api"}"#
    );
    assert_eq!(
        scalar(&mut c, "SELECT ip_address FROM audit_logs WHERE resource = 'org_plan'").await,
        "10.0.0.1"
    );
    assert_eq!(
        scalar(
            &mut c,
            "SELECT action || '/' || user_id FROM audit_logs WHERE resource = 'org_plan'"
        )
        .await,
        "update/3"
    );
    assert_eq!(
        scalar(
            &mut c,
            &format!("SELECT value FROM settings WHERE key = '{PLAN_SETTING_KEY}'")
        )
        .await,
        "ket_noi"
    );

    // Mức dùng: chỉ người đang hoạt động, chưa xoá mềm (người dùng 1 đến 4 đã tạo ở đầu ca).
    let usage = features::usage_summary(&mut c, SINGLE).await.unwrap();
    assert_eq!(
        (usage.plan, usage.plan_label, usage.max_users, usage.active_users),
        ("ket_noi", "Kết nối", Some(10), 2)
    );
    let body = js(&usage);
    assert!(
        body.starts_with(
            r#"{"plan":"ket_noi","plan_label":"Kết nối","max_users":10,"active_users":2,"features":{"dashboard":"#
        ),
        "{body}"
    );
    assert!(!body.contains("price"), "bản Node không có giá gói trong phản hồi");
    features::set_plan(&mut c, SINGLE, PlanKey::Custom, Some(3), "api", None)
        .await
        .unwrap();
    assert_eq!(
        js(&features::usage_summary(&mut c, SINGLE).await.unwrap().max_users),
        "null",
        "không giới hạn ⇒ null"
    );
    assert_eq!(
        scalar(
            &mut c,
            "SELECT count(*)::text FROM audit_logs WHERE resource = 'org_plan' AND ip_address IS NULL"
        )
        .await,
        "1"
    );

    // `setup_status = chua_dung`: khoá thiếu mặc định TẮT (trừ integrations); khoá đã lưu thắng mặc định.
    exec(&mut c, "DELETE FROM settings WHERE key = 'org_features'").await;
    exec(
        &mut c,
        "INSERT INTO settings (key, value, updated_at) VALUES ('setup_status', 'chua_dung', now())",
    )
    .await;
    let blank = js(&features::get(&mut c, SINGLE).await.unwrap());
    assert!(
        blank.contains(r#""integrations":true"#) && blank.contains(r#""contacts":false"#),
        "{blank}"
    );
    exec(
        &mut c,
        "INSERT INTO settings (key, value, updated_at) VALUES ('org_features', '{\"contacts\":true}', now())",
    )
    .await;
    assert!(js(&features::get(&mut c, SINGLE).await.unwrap()).contains(r#""contacts":true"#));
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn doi_goi_chi_voi_token_va_khoa_hop_le() {
    // Token đổi gói: so khớp không phụ thuộc nội dung; chưa cấu hình hoặc rỗng ⇒ khoá với mọi người.
    assert!(verify_plan_token(Some("abc"), Some("abc")));
    assert!(!verify_plan_token(Some("abd"), Some("abc")));
    assert!(!verify_plan_token(Some("ab"), Some("abc")));
    assert!(!verify_plan_token(Some("abc"), None));
    assert!(!verify_plan_token(Some("abc"), Some("")));
    assert!(!verify_plan_token(None, Some("abc")));
    assert!(!verify_plan_token(Some(""), Some("")));
    // Thân PUT /settings/plan.
    assert_eq!(
        validate_plan_body(&json!({"plan": "tro_ly_kinh_doanh"})).unwrap(),
        PlanKey::TroLyKinhDoanh
    );
    for bad in [
        json!({}),
        json!({"plan": "vang"}),
        json!({"plan": 5}),
        json!(null),
        json!({"plan": " ket_noi"}),
    ] {
        let e = validate_plan_body(&bad).unwrap_err();
        assert_eq!(e.status(), 400);
        assert!(serde_json::to_string(&e.body()).unwrap().contains("Gói không hợp lệ. Chọn một trong: mac_dinh, ket_noi, tro_ly_giam_doc, tro_ly_kinh_doanh, tro_ly_van_hanh, custom"));
    }
    assert_eq!(mod_settings::features::plan_token_denied().status(), 403);
}
