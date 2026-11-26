//! Test pg mẫu. Cần Postgres thật qua `TEST_DATABASE_URL`; thiếu biến thì bỏ qua (job `Rust pg tests` của CI đặt biến).

use sqlx::postgres::PgPoolOptions;

#[tokio::test]
async fn ping_tra_ve_1() {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        return;
    };
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("nối được TEST_DATABASE_URL");
    assert_eq!(trinity_db::ping(&pool).await.expect("ping"), 1);
}
