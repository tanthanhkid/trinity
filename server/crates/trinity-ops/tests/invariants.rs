//! X11: bộ kiểm bất biến chạy trên Postgres thật.
//!
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-ops --tests -- --ignored`
//! (`public` đã migrate bằng Prisma). Test dựng schema `c_9301` là bản sao cấu trúc của `public` (bỏ ràng buộc NOT NULL
//! và khoá ngoại để seed gọn), cố ý làm hỏng từng kiểu rồi kiểm bộ kiểm bắt đúng kiểu đó.

use std::time::{Duration, Instant};

use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_db::{Db, DbConfig};
use trinity_ops::{CODE_TABLES, Kind, Options, SOFT_FKS, Snapshot, run};

const S: &str = "c_9301";

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .expect(sql);
}

/// Schema sạch: bảng sao từ `public`, dữ liệu hợp lệ.
async fn setup(c: &mut PgConnection) {
    exec(
        c,
        &format!(
            "DROP SCHEMA IF EXISTS {S} CASCADE; CREATE SCHEMA {S};
             DO $$ DECLARE t text; col text; BEGIN
               FOR t IN SELECT table_name FROM information_schema.tables
                        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' LOOP
                 EXECUTE format('CREATE TABLE {S}.%I (LIKE public.%I INCLUDING ALL)', t, t);
               END LOOP;
               FOR t, col IN SELECT table_name, column_name FROM information_schema.columns
                             WHERE table_schema = '{S}' AND is_nullable = 'NO' AND column_name <> 'id' LOOP
                 BEGIN EXECUTE format('ALTER TABLE {S}.%I ALTER COLUMN %I DROP NOT NULL', t, col);
                 EXCEPTION WHEN invalid_table_definition THEN NULL; END;
               END LOOP;
             END $$;
             INSERT INTO {S}.users (id, created_at, updated_at) SELECT g, now(), now() FROM generate_series(1, 30) g;
             INSERT INTO {S}.users (id, manager_id) VALUES (31, 1);
             INSERT INTO {S}.products (id) VALUES (1), (2);
             INSERT INTO {S}.contacts (id, code, product_id, created_at, updated_at)
               SELECT g, 'KH-' || g, 1, now() - interval '2 day', now() - interval '1 day' FROM generate_series(1, 40) g;
             INSERT INTO {S}.deals (id, code, created_at, updated_at)
               SELECT g, 'DL-' || g, now() - interval '2 day', now() - interval '1 day' FROM generate_series(1, 5) g;
             INSERT INTO {S}.kanban_cards (id, code, contact_id, assignee_id, created_by)
               SELECT g, 'CV-' || g, g, 2, 3 FROM generate_series(1, 5) g;"
        ),
    )
    .await;
}

async fn db() -> Db {
    let mut cfg = DbConfig::new(url());
    cfg.pool_size = 2;
    cfg.acquire_timeout = Duration::from_secs(5);
    Db::connect(&cfg).await.unwrap()
}

fn only() -> Options {
    Options {
        schemas: vec![S.to_owned()],
        ..Options::default()
    }
}

#[tokio::test]
#[ignore = "cần Postgres: TEST_DATABASE_URL"]
async fn bat_du_nam_kieu_hong() {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    let db = db().await;

    // Mốc sạch; thời gian chạy đo luôn (tiêu chí: dưới 5 phút cho mọi schema).
    setup(&mut c).await;
    let t = Instant::now();
    let (report, base) = run(&db, &Snapshot::default(), &only()).await.unwrap();
    assert!(report.ok(), "dữ liệu sạch phải xanh: {:?}", report.violations);
    assert!(t.elapsed() < Duration::from_secs(300));
    assert!(report.tables_checked > 100 && report.json_columns_checked > 40);
    assert_eq!(
        report.orphan_rules_checked,
        SOFT_FKS.len(),
        "mọi quy tắc soft-FK phải áp được trên schema thật"
    );
    // Chạy lại đúng trạng thái đó với mốc: vẫn xanh.
    assert!(run(&db, &base, &only()).await.unwrap().0.ok());

    // 1. số dòng giảm bất thường
    exec(&mut c, &format!("DELETE FROM {S}.contacts WHERE id > 20")).await;
    let (r, _) = run(&db, &base, &only()).await.unwrap();
    assert!(
        r.violations
            .iter()
            .any(|v| v.kind == Kind::RowCountDrop && v.table == "contacts"),
        "{r:?}"
    );
    // ít dòng bị xoá (dưới ngưỡng) thì không báo
    setup(&mut c).await;
    exec(&mut c, &format!("DELETE FROM {S}.contacts WHERE id > 38")).await;
    assert!(run(&db, &base, &only()).await.unwrap().0.ok());

    // 2. updated_at lùi (so mốc) và updated_at < created_at (không cần mốc)
    setup(&mut c).await;
    exec(
        &mut c,
        &format!("UPDATE {S}.deals SET updated_at = updated_at - interval '1 hour'"),
    )
    .await;
    let (r, _) = run(&db, &base, &only()).await.unwrap();
    assert!(
        r.violations
            .iter()
            .any(|v| v.kind == Kind::UpdatedAtRegress && v.table == "deals"),
        "{r:?}"
    );
    setup(&mut c).await;
    exec(
        &mut c,
        &format!("UPDATE {S}.contacts SET updated_at = created_at - interval '1 second' WHERE id = 1"),
    )
    .await;
    let (r, _) = run(&db, &Snapshot::default(), &only()).await.unwrap();
    assert_eq!(
        r.kinds().into_iter().collect::<Vec<_>>(),
        vec![Kind::UpdatedAtRegress],
        "{r:?}"
    );

    // 3. mã tự sinh trùng (gỡ chỉ mục duy nhất của bản thử để chèn được)
    setup(&mut c).await;
    exec(
        &mut c,
        &format!(
            "DO $$ DECLARE i text; BEGIN
               FOR i IN SELECT indexname FROM pg_indexes WHERE schemaname = '{S}' AND tablename = 'deals'
                        AND indexdef LIKE 'CREATE UNIQUE%(code%' LOOP EXECUTE format('DROP INDEX {S}.%I', i); END LOOP;
             END $$;
             INSERT INTO {S}.deals (id, code) VALUES (100, 'DL-1');"
        ),
    )
    .await;
    let (r, _) = run(&db, &base, &only()).await.unwrap();
    let v = r
        .violations
        .iter()
        .find(|v| v.kind == Kind::DuplicateCode)
        .expect("trùng mã");
    assert_eq!(
        (v.table.as_str(), v.detail.as_str()),
        ("deals", "mã trùng (tối đa 5): DL-1")
    );
    assert!(CODE_TABLES.contains(&"deals"));

    // 4. JSON: mã hoá hai lần, và sai kiểu so với mặc định (mảng bị ghi thành đối tượng)
    setup(&mut c).await;
    exec(
        &mut c,
        &format!("UPDATE {S}.contacts SET custom_fields = to_jsonb('[{{\"a\":1}}]'::text) WHERE id = 1"),
    )
    .await;
    let (r, _) = run(&db, &base, &only()).await.unwrap();
    assert!(
        r.violations
            .iter()
            .any(|v| v.kind == Kind::JsonUnreadable && v.table == "contacts" && v.count == 1),
        "{r:?}"
    );
    setup(&mut c).await;
    exec(
        &mut c,
        &format!("UPDATE {S}.contacts SET custom_fields = '{{\"a\":1}}'::jsonb WHERE id <= 3"),
    )
    .await;
    let (r, _) = run(&db, &base, &only()).await.unwrap();
    assert!(
        r.violations
            .iter()
            .any(|v| v.kind == Kind::JsonUnreadable && v.count == 3),
        "{r:?}"
    );
    // chuỗi thường (không phải JSON) trong cột chuỗi-JSON hợp lệ không bị báo oan ở cột không có mặc định mảng/đối tượng
    setup(&mut c).await;
    exec(
        &mut c,
        &format!("UPDATE {S}.rbac_audit_log SET \"after\" = to_jsonb('xin chao'::text)"),
    )
    .await;
    assert!(run(&db, &base, &only()).await.unwrap().0.ok());

    // 5. dòng mồ côi soft-FK; cha bị soft-delete thì vẫn là có cha
    setup(&mut c).await;
    exec(&mut c, &format!("UPDATE {S}.contacts SET deleted_at = now() WHERE id = 1; UPDATE {S}.kanban_cards SET contact_id = 999 WHERE id = 5")).await;
    let (r, _) = run(&db, &base, &only()).await.unwrap();
    assert_eq!(r.violations.len(), 1, "{r:?}");
    let v = &r.violations[0];
    assert_eq!(
        (v.kind, v.table.as_str(), v.column.as_deref(), v.count),
        (Kind::OrphanSoftFk, "kanban_cards", Some("contact_id"), 1)
    );

    // Không ghi gì vào DB: phiên chỉ đọc.
    setup(&mut c).await;
    let _ = run(&db, &base, &only()).await.unwrap();

    exec(&mut c, &format!("DROP SCHEMA {S} CASCADE")).await;
}

#[tokio::test]
#[ignore = "cần Postgres: TEST_DATABASE_URL"]
async fn chay_tren_public_va_mot_tep_mot_moc() {
    let db = db().await;
    let (r, snap) = run(&db, &Snapshot::default(), &Options::default()).await.unwrap();
    assert!(r.schemas_checked.contains(&"public".to_owned()));
    let dir = std::env::temp_dir().join(format!("x11-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("state.json");
    assert!(
        Snapshot::load(&path).unwrap().schemas.is_empty(),
        "chưa có tệp = chưa có mốc"
    );
    snap.save(&path).unwrap();
    assert_eq!(Snapshot::load(&path).unwrap().schemas.len(), snap.schemas.len());
    std::fs::remove_dir_all(&dir).unwrap();
}
