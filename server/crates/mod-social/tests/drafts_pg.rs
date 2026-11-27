//! Nháp, khung giờ hàng đợi và mẫu chữ trên Postgres thật (M55a). Pool chỉ 1 kết nối: mã giữ kết nối khi xin kết nối thứ hai sẽ
//! treo rồi hết hạn chờ. Dữ liệu mang tiền tố `m55a`; bảng `social_queue_slots` không có khoá tên nên test xoá sạch lúc đầu và
//! lúc cuối (chỉ chạy trên DB thử).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-social --test drafts_pg -- --ignored`

use std::sync::Arc;
use std::time::Duration;

use mod_facebook::config::Env;
use mod_social::drafts::{self, DraftInput};
use mod_social::media::{self, MediaCtx, MediaStore};
use mod_social::queue::{self, QueueSlot};
use mod_social::snippets::{self, SnippetInput};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_kernel::error::AppError;
use trinity_storage::LocalDiskDriver;

/// 2026-11-27 (thứ Sáu) 10:00 giờ Việt Nam.
const NOW: i64 = 1_795_748_400_000;
const MINUTE: i64 = 60_000;

fn status(e: AppError) -> (u16, Value) {
    let (s, b) = e.response(true);
    // trinity-lint: allow-json-value (thông báo lỗi/giá trị so sánh trong test, không phải model hay cột DB)
    (s, serde_json::to_value(&b.message).unwrap())
}

async fn clean(c: &mut PgConnection) {
    for sql in [
        "DELETE FROM social_drafts WHERE title LIKE 'm55a%' OR source LIKE 'm55a%'",
        "DELETE FROM social_snippets WHERE name LIKE 'm55a%'",
        "DELETE FROM social_posts WHERE content LIKE 'm55a%'",
        "DELETE FROM social_queue_slots",
        "DELETE FROM social_accounts WHERE external_id LIKE 'm55a%'",
        "DELETE FROM social_media_assets WHERE name LIKE 'm55a%'",
        "DELETE FROM users WHERE email LIKE 'm55a%@test.local'",
    ] {
        sqlx::query(sql).execute(&mut *c).await.unwrap();
    }
}

fn draft(v: Value) -> DraftInput {
    DraftInput::from_json(&v).unwrap()
}

fn snip(v: Value) -> SnippetInput {
    SnippetInput::from_json(&v).unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn nhap_khung_gio_mau_chu() {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 1;
    cfg.acquire_timeout = Duration::from_secs(3);
    let db = Db::connect(&cfg).await.expect("nối DB");
    let company = CompanyRef::DEFAULT;
    let root = std::env::temp_dir().join(format!("m55a-{}", std::process::id()));
    let local = LocalDiskDriver::new(&root);
    local.init().await.unwrap();
    let store = MediaStore::Local(local);
    let env: Env = Arc::new(|_| None);

    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    clean(&mut c).await;
    let user: i32 = sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, full_name, status, updated_at) \
         VALUES ('m55aa@test.local', 'x', 'M55a', 'active', now()) RETURNING id",
    )
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let account: i32 = sqlx::query_scalar(
        "INSERT INTO social_accounts (network, external_id, name, access_token_enc, connected_by) \
         VALUES ('facebook', 'm55a-page', 'm55a page', 'x', $1) RETURNING id",
    )
    .bind(user)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let off: i32 = sqlx::query_scalar(
        "INSERT INTO social_accounts (network, external_id, name, access_token_enc, connected_by, status) \
         VALUES ('facebook', 'm55a-off', 'm55a off', '', $1, 'disabled') RETURNING id",
    )
    .bind(user)
    .fetch_one(&mut *c)
    .await
    .unwrap();

    // ── Khung giờ hàng đợi ──
    assert!(
        queue::next_free(&mut c, 3, NOW).await.unwrap().is_empty(),
        "chưa có khung ⇒ rỗng"
    );
    let set = queue::set_slots(
        &mut c,
        &[
            QueueSlot {
                weekday: 5,
                minute: 660,
            },
            QueueSlot {
                weekday: 1,
                minute: 480,
            },
            QueueSlot {
                weekday: 5,
                minute: 660,
            },
        ],
    )
    .await
    .unwrap();
    assert_eq!(
        set,
        [
            QueueSlot {
                weekday: 1,
                minute: 480
            },
            QueueSlot {
                weekday: 5,
                minute: 660
            }
        ],
        "sắp, bỏ trùng"
    );
    assert_eq!(queue::slots(&mut c).await.unwrap(), set);
    let next = queue::next_free(&mut c, 3, NOW).await.unwrap();
    let iso: Vec<String> = next
        .iter()
        .map(|d| trinity_kernel::vn_time::js_iso_string(*d))
        .collect();
    // Thứ Sáu 11:00 VN hôm nay (04:00 UTC), thứ Hai 08:00 VN (01:00 UTC), thứ Sáu tuần sau.
    assert_eq!(
        iso,
        [
            "2026-11-27T04:00:00.000Z",
            "2026-11-30T01:00:00.000Z",
            "2026-12-04T04:00:00.000Z"
        ]
    );
    // Khung đã có bài hẹn cùng phút thì bỏ; bài đã huỷ không tính.
    let first_ms = next[0].timestamp_millis();
    let post: i32 = sqlx::query_scalar(
        "INSERT INTO social_posts (content, scheduled_at, status, created_by, updated_at) \
         VALUES ('m55a bài', $1, 'scheduled', $2, now()) RETURNING id",
    )
    .bind(next[0])
    .bind(user)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let again = queue::next_free(&mut c, 1, NOW).await.unwrap();
    assert_eq!(
        trinity_kernel::vn_time::js_iso_string(again[0]),
        "2026-11-30T01:00:00.000Z"
    );
    assert!(!queue::is_free(&mut c, first_ms, NOW).await.unwrap());
    assert!(queue::is_free(&mut c, first_ms + 7 * 86_400_000, NOW).await.unwrap());
    assert!(
        !queue::is_free(&mut c, NOW + MINUTE - 1, NOW).await.unwrap(),
        "còn dưới 1 phút"
    );
    sqlx::query("UPDATE social_posts SET status = 'cancelled' WHERE id = $1")
        .bind(post)
        .execute(&mut *c)
        .await
        .unwrap();
    assert!(queue::is_free(&mut c, first_ms, NOW).await.unwrap());
    assert!(queue::set_slots(&mut c, &[]).await.unwrap().is_empty());
    assert!(queue::slots(&mut c).await.unwrap().is_empty());
    assert_eq!(
        status(
            queue::set_slots(&mut c, &[QueueSlot { weekday: 7, minute: 0 }])
                .await
                .unwrap_err()
        )
        .0,
        400
    );

    // ── Mẫu chữ ──
    let tags = snippets::create(
        &mut c,
        user,
        &snip(json!({"kind":"hashtags","name":"  m55a tag ","content":"tết, #Tết sale"})),
    )
    .await
    .unwrap();
    assert_eq!((tags.name.as_str(), tags.content.as_str()), ("m55a tag", "#tết #sale"));
    let sig1 = snippets::create(
        &mut c,
        user,
        &snip(json!({"kind":"signature","name":"m55a ký 1","content":" Cảm ơn! ","is_default":true})),
    )
    .await
    .unwrap();
    let sig2 = snippets::create(
        &mut c,
        user,
        &snip(json!({"kind":"signature","name":"m55a ký 2","content":"Thân","is_default":true})),
    )
    .await
    .unwrap();
    assert!(sig1.is_default && sig2.is_default && sig2.position == sig1.position + 1);
    let all = snippets::list(&mut c, Some("signature")).await.unwrap();
    let mine: Vec<_> = all.iter().filter(|s| s.name.starts_with("m55a")).collect();
    assert_eq!(mine.len(), 2);
    assert!(!mine[0].is_default && mine[1].is_default, "chỉ một chữ ký mặc định");
    assert_eq!(status(snippets::list(&mut c, Some("x")).await.unwrap_err()).0, 400);
    for (body, msg) in [
        (
            json!({"kind":"hashtags","name":"m55a x","content":"a","is_default":true}),
            "Chỉ chữ ký mới đặt được mặc định.",
        ),
        (
            json!({"kind":"hashtags","name":"m55a x","content":"a#b"}),
            "Hashtag \"#a#b\" chứa nhiều dấu #; tách bằng dấu cách.",
        ),
        (json!({"kind":"signature","name":null,"content":"a"}), "Cần tên mẫu."),
        (
            json!({"name":"m55a x","content":"a"}),
            "Loại mẫu phải là hashtags hoặc signature.",
        ),
        (
            json!({"kind":"signature","name":"m55a x","content":"a","is_default":null}),
            "is_default phải là true/false.",
        ),
    ] {
        let (s, m) = status(snippets::create(&mut c, user, &snip(body)).await.unwrap_err());
        assert_eq!((s, m), (400, json!(msg)));
    }
    let up = snippets::update(&mut c, sig1.id, &snip(json!({"is_default":true,"content":"Mới"})))
        .await
        .unwrap();
    assert!(up.is_default && up.content == "Mới" && up.updated_at >= sig1.updated_at);
    assert!(
        !snippets::list(&mut c, Some("signature"))
            .await
            .unwrap()
            .iter()
            .any(|s| s.id == sig2.id && s.is_default)
    );
    assert_eq!(
        status(
            snippets::update(&mut c, sig1.id, &snip(json!({"kind":"hashtags"})))
                .await
                .unwrap_err()
        ),
        (400, json!("Không đổi loại của mẫu đã tạo."))
    );
    assert_eq!(
        status(snippets::update(&mut c, 0, &snip(json!({}))).await.unwrap_err()).0,
        404
    );
    // Giới hạn 100 mẫu: lấp đầy bằng mẫu tên m55a rồi thêm một mẫu nữa ⇒ 400.
    let have: i64 = sqlx::query_scalar("SELECT count(*) FROM social_snippets")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    for i in 0..(100 - have) {
        snippets::create(
            &mut c,
            user,
            &snip(json!({"kind":"hashtags","name":format!("m55a đầy {i}"),"content":"x"})),
        )
        .await
        .unwrap();
    }
    assert_eq!(
        status(
            snippets::create(
                &mut c,
                user,
                &snip(json!({"kind":"hashtags","name":"m55a thừa","content":"x"}))
            )
            .await
            .unwrap_err()
        ),
        (400, json!("Tối đa 100 mẫu."))
    );
    snippets::remove(&mut c, tags.id).await.unwrap();
    assert_eq!(status(snippets::remove(&mut c, tags.id).await.unwrap_err()).0, 404);
    drop(c);

    // ── Nháp ──
    let ctx = MediaCtx {
        db: &db,
        company,
        store: &store,
        env: &env,
        user_id: user,
        now_ms: NOW,
    };
    let png = [1_u8; 64];
    let m = media::upload_stream(&ctx, "m55a-anh.png", &png[..]).await.unwrap();

    let d1 = drafts::create(&ctx, &draft(json!({"title":"m55a một"})), "web", None)
        .await
        .unwrap();
    assert_eq!(
        (d1.content.as_str(), d1.use_queue, d1.source.as_str()),
        ("", false, "web")
    );
    assert_eq!((d1.media.0.clone(), d1.targets.0.clone()), (json!([]), json!([])));
    let d2 = drafts::create(
        &ctx,
        &draft(json!({
            "title":"m55a hai","content":"xin chào","media":[{"key": m.key, "name":"ảnh"}],
            "targets":[{"account_id":account,"caption":"  ","options":{}}],
            "scheduled_at":"2026-12-01T03:00:00Z","utm":{"campaign":"tết  2027"}
        })),
        "web",
        None,
    )
    .await
    .unwrap();
    assert_eq!(d2.media.0[0]["name"], "ảnh");
    assert_eq!(
        d2.targets.0,
        json!([{"account_id":account,"options":{"utm":{"campaign":"tết-2027"}}}])
    );
    assert_eq!(d2.scheduled_at.unwrap().0.timestamp(), 1_796_094_000);

    // Kiểm: kênh lạ/đã tắt, trùng kênh, vừa hàng đợi vừa giờ, khoá tệp lạ, UTM xấu ⇒ 400, không tạo dòng.
    for (body, msg) in [
        (
            json!({"targets":[{"account_id": 999_999}]}),
            "Không tìm thấy kênh #999999.".to_owned(),
        ),
        (
            json!({"targets":[{"account_id": off}]}),
            format!("Không tìm thấy kênh #{off}."),
        ),
        (
            json!({"targets":[{"account_id": account},{"account_id": account}]}),
            "Mỗi kênh chỉ chọn một lần.".to_owned(),
        ),
        (
            json!({"use_queue":true,"scheduled_at":"2026-12-01T03:00:00Z"}),
            "Chỉ chọn một: vào hàng đợi hoặc giờ hẹn cụ thể.".to_owned(),
        ),
        (
            json!({"media":[{"key":"social/u1_1_aaaaaa.png"}]}),
            "Tệp không hợp lệ: social/u1_1_aaaaaa.png".to_owned(),
        ),
        (
            json!({"utm":{"campaign":"a&b"}}),
            "UTM: tên chiến dịch (campaign) không được chứa các ký tự & # = ? % /.".to_owned(),
        ),
        (json!({"content": null}), "Nội dung tối đa 63206 ký tự.".to_owned()),
    ] {
        let (s, got) = status(
            drafts::create(&ctx, &draft(body.clone()), "web", None)
                .await
                .unwrap_err(),
        );
        assert_eq!((s, got), (400, json!(msg)), "{body}");
    }

    // Sửa: chỉ trường có gửi; đổi nội dung mà không gửi `ui` ⇒ `ui` bị bỏ; `updated_at` tiến lên.
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    sqlx::query("UPDATE social_drafts SET ui = '{\"step\":2}' WHERE id = $1")
        .bind(d2.id)
        .execute(&mut *c)
        .await
        .unwrap();
    drop(c);
    let u = drafts::update(&ctx, d2.id, &draft(json!({"title":"  m55a hai sửa  "})))
        .await
        .unwrap();
    assert_eq!(
        (u.title.as_deref(), u.content.as_str()),
        (Some("m55a hai sửa"), "xin chào")
    );
    assert_eq!(
        u.ui.map(|j| j.0),
        Some(json!({"step":2})),
        "không đụng nội dung ⇒ giữ ui"
    );
    assert_eq!(u.targets, d2.targets, "không gửi targets ⇒ giữ nguyên");
    assert!(u.updated_at >= d2.updated_at);
    let u = drafts::update(&ctx, d2.id, &draft(json!({"content":"mới"})))
        .await
        .unwrap();
    assert_eq!((u.content.as_str(), u.ui), ("mới", None));
    // UTM: đổi danh sách kênh không gửi utm ⇒ giữ; utm null ⇒ bỏ.
    let u = drafts::update(&ctx, d2.id, &draft(json!({"targets":[{"account_id":account}]})))
        .await
        .unwrap();
    assert_eq!(u.targets.0[0]["options"]["utm"]["campaign"], "tết-2027");
    let u = drafts::update(&ctx, d2.id, &draft(json!({"utm":null}))).await.unwrap();
    assert_eq!(u.targets.0, json!([{"account_id":account}]));
    // use_queue xoá giờ hẹn; scheduled_at đặt use_queue về false.
    let u = drafts::update(&ctx, d2.id, &draft(json!({"use_queue":true})))
        .await
        .unwrap();
    assert_eq!((u.use_queue, u.scheduled_at), (true, None));
    let u = drafts::update(&ctx, d2.id, &draft(json!({"scheduled_at":"2026-12-02T00:00:00.000Z"})))
        .await
        .unwrap();
    assert!(!u.use_queue && u.scheduled_at.is_some());
    assert_eq!(
        status(drafts::update(&ctx, 0, &draft(json!({}))).await.unwrap_err()).0,
        404
    );

    // Danh sách: nháp mở, mới sửa trước. Đã đăng ẩn; giữ chỗ còn mới ẩn, giữ chỗ kẹt > 10 phút mở lại.
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let ids: Vec<i32> = drafts::list(&mut c, NOW)
        .await
        .unwrap()
        .into_iter()
        .filter(|d| d.title.as_deref().is_some_and(|t| t.starts_with("m55a")))
        .map(|d| d.id)
        .collect();
    assert_eq!(ids, [d2.id, d1.id]);
    sqlx::query("UPDATE social_drafts SET post_id = $2 WHERE id = $1")
        .bind(d1.id)
        .bind(post)
        .execute(&mut *c)
        .await
        .unwrap();
    assert_eq!(
        status(drafts::get(&mut c, d1.id, NOW).await.unwrap_err()).0,
        404,
        "đã đăng ⇒ ẩn"
    );
    sqlx::query(
        "UPDATE social_drafts SET post_id = -1, publishing_at = to_timestamp($2::float8 / 1000.0) WHERE id = $1",
    )
    .bind(d1.id)
    .bind(NOW as f64 - 60_000.0)
    .execute(&mut *c)
    .await
    .unwrap();
    assert_eq!(
        status(drafts::get(&mut c, d1.id, NOW).await.unwrap_err()).0,
        404,
        "giữ chỗ còn mới"
    );
    assert!(
        drafts::get(&mut c, d1.id, NOW + 11 * MINUTE).await.is_ok(),
        "giữ chỗ kẹt ⇒ mở lại"
    );
    drop(c);
    assert_eq!(
        status(
            drafts::update(&ctx, d1.id, &draft(json!({"content":"x"})))
                .await
                .unwrap_err()
        ),
        (409, json!("Nháp này đang được đăng hoặc đã đăng, không sửa được nữa."))
    );
    let ctx_late = MediaCtx {
        db: &db,
        company,
        store: &store,
        env: &env,
        user_id: user,
        now_ms: NOW + 11 * MINUTE,
    };
    let u = drafts::update(&ctx_late, d1.id, &draft(json!({"content":"mở lại"})))
        .await
        .unwrap();
    assert_eq!((u.post_id, u.publishing_at), (None, None));

    // Tạo trùng khoá (nhập CSV): lần hai ⇒ 409; xoá nháp đang giữ chỗ ⇒ 404.
    let a = drafts::create(&ctx, &draft(json!({"title":"m55a csv"})), "web", Some("m55a-csv-1"))
        .await
        .unwrap();
    assert_eq!(a.source, "m55a-csv-1");
    assert_eq!(
        status(
            drafts::create(&ctx, &draft(json!({"title":"m55a csv"})), "web", Some("m55a-csv-1"))
                .await
                .unwrap_err()
        ),
        (409, json!(drafts::ALREADY_CREATED))
    );
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    drafts::remove(&mut c, a.id, NOW).await.unwrap();
    assert_eq!(status(drafts::remove(&mut c, a.id, NOW).await.unwrap_err()).0, 404);
    drafts::remove(&mut c, d2.id, NOW).await.unwrap();
    drafts::remove(&mut c, d1.id, NOW).await.unwrap();

    clean(&mut c).await;
    let _ = std::fs::remove_dir_all(root);
}
