//! `trinity seed` và `trinity channel-lock` chạy thật (K32). Cần Postgres có `public` đã migrate bằng Prisma, một DB riêng
//! (bảng users/roles/… bị xoá): `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_k32 cargo test -p trinity-bin
//! --test seed_channel_lock_cli -- --ignored --test-threads=1`.

use std::process::{Command, Output};

use sqlx::{Connection, PgConnection};

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

fn trinity(args: &[&str], env: &[(&str, &str)], multi_tenant: bool) -> Output {
    let mut c = Command::new(env!("CARGO_BIN_EXE_trinity"));
    c.args(args).env_clear().env("DATABASE_URL", url());
    if multi_tenant {
        c.env("MULTI_TENANT", "true");
    }
    if let Ok(p) = std::env::var("PATH") {
        c.env("PATH", p);
    }
    for (k, v) in env {
        c.env(k, v);
    }
    c.output().expect("chạy được binary trinity")
}

fn text(o: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

fn exec(sql: &str) {
    block_on(async {
        let mut c = PgConnection::connect(&url()).await.unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned()))
            .execute(&mut c)
            .await
            .unwrap();
    });
}

fn scalar(sql: &str) -> String {
    block_on(async {
        let mut c = PgConnection::connect(&url()).await.unwrap();
        sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql.to_owned()))
            .fetch_one(&mut c)
            .await
            .unwrap()
    })
}

/// Dấu vân tay của mọi bảng seed (kể cả `updated_at`): seed lặp lại phải cho cùng một giá trị.
fn fingerprint() -> String {
    scalar(
        "SELECT md5(concat_ws('|',
           (SELECT coalesce(string_agg(t::text, ',' ORDER BY id), '') FROM roles t),
           (SELECT coalesce(string_agg(t::text, ',' ORDER BY id), '') FROM setting_options t),
           (SELECT coalesce(string_agg(t::text, ',' ORDER BY id), '') FROM users t),
           (SELECT coalesce(string_agg(t::text, ',' ORDER BY id), '') FROM user_roles t),
           (SELECT coalesce(string_agg(t::text, ',' ORDER BY id), '') FROM kanban_boards t),
           (SELECT coalesce(string_agg(t::text, ',' ORDER BY id), '') FROM kanban_columns t),
           (SELECT coalesce(string_agg(t::text, ',' ORDER BY id), '') FROM teams t),
           (SELECT coalesce(string_agg(t::text, ',' ORDER BY id), '') FROM contacts t),
           (SELECT coalesce(string_agg(t::text, ',' ORDER BY key), '') FROM settings t)))",
    )
}

fn clean() {
    exec(
        "TRUNCATE kanban_boards, kanban_columns, contacts, teams, setting_options, user_roles, roles, users, settings, channel_events RESTART IDENTITY CASCADE",
    );
}

#[test]
#[ignore = "cần Postgres: xem đầu tệp"]
fn seed_lap_lai_khong_doi_du_lieu() {
    clean();
    let env = [
        ("SEED_ADMIN_EMAIL", "Admin@Example.com"),
        ("SEED_ADMIN_PASSWORD", "Mat-khau-thu-1"),
    ];
    let o = trinity(&["seed"], &env, false);
    assert!(o.status.success(), "{}", text(&o));
    let t = text(&o);
    for want in [
        "Seeded role: Quản trị (is_system)",
        "Seeded 14 setting options: contact_source=7, contact_stage=4, contact_detail_status=3",
        "Admin account created: admin@example.com",
        "Password taken from SEED_ADMIN_PASSWORD.",
        "Seeded default kanban board",
        "Seed completed!",
    ] {
        assert!(t.contains(want), "thiếu {want:?}:\n{t}");
    }
    assert!(!t.contains("Mat-khau-thu-1"), "không in mật khẩu lấy từ env");
    assert_eq!(scalar("SELECT count(*)::text FROM setting_options"), "14");
    assert_eq!(scalar("SELECT count(*)::text FROM kanban_columns"), "3");
    assert_eq!(
        scalar("SELECT string_agg(position::text, ',' ORDER BY position) FROM kanban_columns"),
        "1024,2048,3072"
    );
    let hash = scalar("SELECT password_hash FROM users WHERE email = 'admin@example.com'");
    assert!(hash.starts_with("$2"), "{hash}");

    let before = fingerprint();
    let o = trinity(
        &["seed"],
        &[
            ("SEED_ADMIN_EMAIL", "admin@example.com"),
            ("SEED_ADMIN_PASSWORD", "Mat-khau-khac"),
        ],
        false,
    );
    assert!(o.status.success(), "{}", text(&o));
    assert!(
        text(&o).contains("already exists — password left unchanged."),
        "{}",
        text(&o)
    );
    assert_eq!(fingerprint(), before, "seed lặp lại đổi dữ liệu");
    assert_eq!(
        scalar("SELECT password_hash FROM users WHERE email = 'admin@example.com'"),
        hash
    );
}

#[test]
#[ignore = "cần Postgres: xem đầu tệp"]
fn seed_khong_ghi_de_is_active_va_khong_dung_lai_bang_da_xoa() {
    clean();
    let o = trinity(&["seed"], &[("SEED_ADMIN_PASSWORD", "x")], false);
    assert!(o.status.success(), "{}", text(&o));
    // Quản trị tắt một nhãn, đổi nhãn một mục; xoá hết bảng công việc.
    exec(
        "UPDATE setting_options SET is_active = false WHERE value = 'website'; UPDATE setting_options SET label = 'Sai' WHERE value = 'zalo'; DELETE FROM kanban_columns; UPDATE kanban_boards SET deleted_at = now()",
    );
    let o = trinity(&["seed"], &[], false);
    assert!(o.status.success(), "{}", text(&o));
    assert_eq!(
        scalar("SELECT is_active::text FROM setting_options WHERE value = 'website'"),
        "false"
    );
    assert_eq!(
        scalar("SELECT label FROM setting_options WHERE value = 'zalo'"),
        "Zalo",
        "nhãn được khôi phục như bản Node"
    );
    assert_eq!(
        scalar("SELECT count(*)::text FROM kanban_boards"),
        "1",
        "không dựng lại bảng khi đã từng có bảng"
    );
}

#[test]
#[ignore = "cần Postgres: xem đầu tệp"]
fn seed_mat_khau_ngau_nhien_va_du_lieu_mau_lap_lai_khong_doi() {
    clean();
    let o = trinity(&["seed"], &[("SEED_DEMO_DATA", "true")], false);
    assert!(o.status.success(), "{}", text(&o));
    let t = text(&o);
    assert!(
        t.contains("Generated password (shown ONCE, change it after login): "),
        "{t}"
    );
    assert!(t.contains("Seeded demo data: 2 teams, 5 contacts"), "{t}");
    assert_eq!(
        scalar("SELECT value FROM settings WHERE key = 'setup_status'"),
        "da_dung"
    );
    let before = fingerprint();
    let o = trinity(&["seed"], &[("SEED_DEMO_DATA", "true")], false);
    assert!(
        text(&o).contains("Seeded demo data: 2 teams, 0 contacts"),
        "{}",
        text(&o)
    );
    assert_eq!(fingerprint(), before);
}

#[test]
#[ignore = "cần Postgres: xem đầu tệp"]
fn channel_lock_bon_lenh() {
    clean();
    exec("DROP SCHEMA IF EXISTS platform CASCADE");
    let list = || text(&trinity(&["channel-lock", "list"], &[], true));
    let l = list();
    assert!(
        l.lines()
            .any(|x| x.trim_start().starts_with('1') && x.contains("open") && x.contains("active")),
        "{l}"
    );

    let o = trinity(&["channel-lock", "lock", "1", "tạm", "khoá", "để", "kiểm"], &[], true);
    assert!(
        o.status.success() && text(&o).contains("Company 1: outbound channels LOCKED"),
        "{}",
        text(&o)
    );
    let l = list();
    assert!(l.contains("LOCKED") && l.contains("— tạm khoá để kiểm"), "{l}");

    let o = trinity(&["channel-lock", "unlock", "1"], &[], true);
    assert!(
        text(&o).contains("Company 1: outbound channels unlocked"),
        "{}",
        text(&o)
    );
    assert!(!list().contains("LOCKED"));

    // lock không lý do ⇒ lý do mặc định.
    trinity(&["channel-lock", "lock", "1"], &[], true);
    assert!(list().contains("— Chủ nền tảng tạm khoá kênh gửi ra ngoài"));
    trinity(&["channel-lock", "unlock", "1"], &[], true);

    // Công ty không có ⇒ mã 1; id sai ⇒ mã 2.
    let o = trinity(&["channel-lock", "lock", "999"], &[], true);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(text(&o).contains("Company 999 not found"));
    let o = trinity(&["channel-lock", "unlock", "0"], &[], true);
    assert_eq!(o.status.code(), Some(2), "{}", text(&o));

    // resume: chưa có lần tạm dừng ⇒ không làm gì; có lần còn hiệu lực ⇒ ghi auto_resume; lần đã hết hạn ⇒ không làm gì.
    let o = trinity(&["channel-lock", "resume", "1"], &[], true);
    assert!(
        text(&o).contains("Company 1: no automatic pause in effect"),
        "{}",
        text(&o)
    );
    exec(
        "INSERT INTO channel_events (kind, message, meta) VALUES ('auto_pause', 'x', jsonb_build_object('until', to_char(now() + interval '1 hour', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')))",
    );
    let o = trinity(&["channel-lock", "resume", "1"], &[], true);
    assert!(text(&o).contains("Company 1: automatic pause ended"), "{}", text(&o));
    assert_eq!(
        scalar("SELECT kind FROM channel_events ORDER BY id DESC LIMIT 1"),
        "auto_resume"
    );
    let o = trinity(&["channel-lock", "resume", "1"], &[], true);
    assert!(text(&o).contains("no automatic pause in effect"), "{}", text(&o));
    exec(
        "INSERT INTO channel_events (kind, message, meta) VALUES ('auto_pause', 'x', jsonb_build_object('until', '2020-01-01T00:00:00Z'))",
    );
    let o = trinity(&["channel-lock", "resume", "1"], &[], true);
    assert!(
        text(&o).contains("no automatic pause in effect"),
        "đã hết hạn: {}",
        text(&o)
    );
    assert_eq!(
        scalar("SELECT kind FROM channel_events ORDER BY id DESC LIMIT 1"),
        "auto_pause"
    );
}
