//! Test pg mẫu, cần Postgres thật nên mặc định bị bỏ qua (`#[ignore]`). Chạy có chủ đích:
//! `TEST_DATABASE_URL=postgresql://localhost/trinity_<tên> cargo test -p trinity-db -- --ignored`.
//! Job `Rust pg tests` trên CI (docs/ci.md) chạy các test này bằng `--ignored`.

use sqlx::postgres::PgPoolOptions;

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .expect("test pg cần TEST_DATABASE_URL (Postgres 16 đã migrate bằng Prisma, xem server/README.md)")
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn ping_tra_ve_1() {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&test_database_url())
        .await
        .expect("nối được TEST_DATABASE_URL");
    assert_eq!(trinity_db::ping(&pool).await.expect("ping"), 1);
}
