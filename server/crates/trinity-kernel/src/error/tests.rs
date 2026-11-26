use serde_json::{Value, json};

use super::*;

const GOLDEN: &str = include_str!("../../../../contracts/errors.golden.json");

/// Cùng tên ca với `packages/logger/src/error-golden.spec.ts`; (lỗi, request có đăng nhập).
fn case(name: &str) -> (AppError, bool) {
    let h = |e: HttpError| (AppError::Http(e), false);
    match name {
        "bad_request_message" => h(HttpError::bad_request("Số điện thoại không hợp lệ")),
        "bad_request_default" => h(HttpError::nest(400, None)),
        "validation_messages" => h(HttpError::validation(vec![
            "email must be an email".into(),
            "name should not be empty".into(),
        ])),
        "field_errors" => h(HttpError::field_errors(
            "Dữ liệu không hợp lệ",
            json!({ "gia_goc": "phải là số nguyên" }),
        )),
        "parse_int_pipe" => h(HttpError::parse_int_failed()),
        "unauthorized_default" => h(HttpError::nest(401, None)),
        "unauthorized_message" => h(HttpError::unauthorized("Phiên đăng nhập đã hết hạn")),
        "forbidden_default" => h(HttpError::nest(403, None)),
        "forbidden_message" => h(HttpError::forbidden("Bạn không có quyền thực hiện thao tác này")),
        "not_found_default" => h(HttpError::nest(404, None)),
        "not_found_message" => h(HttpError::not_found("Không tìm thấy khách hàng")),
        "conflict_message" => h(HttpError::conflict("Mã sản phẩm đã tồn tại")),
        "payload_too_large" => h(HttpError::payload_too_large("Tệp quá lớn")),
        "http_exception_string" => h(HttpError::new(429, "Quá nhiều yêu cầu, thử lại sau")),
        "http_exception_object" => h(HttpError::with_label(403, "Tính năng chưa bật", "Feature Disabled")),
        "internal_plain_error" => (AppError::internal("connect ECONNREFUSED 10.0.0.5:5432"), false),
        "internal_http_exception" => {
            let mut e = HttpError::nest(500, Some("Không tạo được phiếu".into()));
            e.errors = Some(json!({ "secret": "y" }));
            h(e)
        }
        "service_unavailable" => h(HttpError::service_unavailable("Máy chủ đang bảo trì")),
        "prisma_p2002_uncaught" => (
            DbError::from_postgres(
                Some("23505"),
                Some("users_email_key"),
                "duplicate key value violates unique constraint",
            )
            .into(),
            false,
        ),
        "prisma_p2025_uncaught" => (DbError::not_found().into(), false),
        "tenant_email_taken" => (
            DbError::from_postgres(Some("P0001"), None, "ERROR: TRINITY_EMAIL_TAKEN: a@b.c").into(),
            false,
        ),
        "tenant_route_taken" => (
            DbError::from_postgres(
                Some("P0001"),
                None,
                "TRINITY_ROUTE_TAKEN: facebook_page 1 is connected to another company",
            )
            .into(),
            false,
        ),
        "missing_company_public" => (AppError::MissingCompanyContext, false),
        "missing_company_signed_in" => (AppError::MissingCompanyContext, true),
        other => panic!("ca golden {other} chưa có bản Rust"),
    }
}

#[test]
fn snapshot_moi_loai_loi_khop_golden_tu_node() {
    let golden: serde_json::Map<String, Value> = serde_json::from_str(GOLDEN).expect("golden là JSON");
    assert!(golden.len() >= 12, "golden có {} loại lỗi, cần ≥ 12", golden.len());
    for (name, want) in &golden {
        let (err, authenticated) = case(name);
        let (status, body) = err.response(authenticated);
        let got = json!({ "status": status, "body": body });
        assert_eq!(&got, want, "ca {name}");
    }
}

#[test]
fn thu_tu_khoa_body_nhu_node() {
    let (_, body) = AppError::Http(HttpError::field_errors("x", json!({"a": "b"}))).response(false);
    assert_eq!(
        serde_json::to_string(&body).unwrap(),
        r#"{"statusCode":400,"message":"x","error":"x","errors":{"a":"b"}}"#
    );
}

#[test]
fn loi_5xx_khong_lo_chi_tiet() {
    let secret = "password authentication failed for user trinity at 10.0.0.5";
    for err in [
        AppError::internal(secret),
        DbError::from_postgres(Some("28P01"), None, secret).into(),
        DbError::from_postgres(Some("23505"), Some("k"), secret).into(),
    ] {
        let (status, body) = err.response(true);
        assert_eq!(status, 500);
        let text = serde_json::to_string(&body).unwrap();
        assert!(!text.contains("10.0.0.5") && !text.contains("password"), "{text}");
        assert_eq!(
            text,
            r#"{"statusCode":500,"message":"Internal server error","error":"Internal Server Error"}"#
        );
    }
}

#[test]
fn bang_anh_xa_sqlstate_sang_ma_prisma() {
    for (sqlstate, kind, prisma) in [
        ("23505", DbErrorKind::UniqueViolation, Some("P2002")),
        ("23503", DbErrorKind::ForeignKeyViolation, Some("P2003")),
        ("23502", DbErrorKind::Other, None),
        ("40001", DbErrorKind::Other, None),
        ("P0001", DbErrorKind::Other, None),
    ] {
        assert_eq!(DbErrorKind::from_sqlstate(sqlstate), kind, "{sqlstate}");
        assert_eq!(kind.prisma_code(), prisma, "{sqlstate}");
    }
    // Cập nhật/xoá 0 dòng ↔ P2025.
    assert_eq!(DbError::not_found().kind.prisma_code(), Some("P2025"));
    assert_eq!(DbError::from_postgres(None, None, "x").kind, DbErrorKind::Other);
}

#[test]
fn bat_dung_rang_buoc_nhu_ban_ts() {
    // Bản TS: `err.code === 'P2002' && target là products_code_key` ⇒ 409; ràng buộc khác ⇒ ném tiếp (500).
    let e = DbError::from_postgres(Some("23505"), Some("products_code_key"), "dup");
    assert!(e.is(DbErrorKind::UniqueViolation, Some("products_code_key")));
    assert!(!e.is(DbErrorKind::UniqueViolation, Some("products_slug_key")));
    assert!(e.is(DbErrorKind::UniqueViolation, None));
    assert!(!e.is(DbErrorKind::ForeignKeyViolation, None));
}

#[test]
fn loi_trigger_da_cong_ty_thanh_409_dung_cau() {
    let (s, b) = AppError::from(DbError::from_postgres(
        Some("P0001"),
        None,
        "TRINITY_EMAIL_TAKEN: x@y.z",
    ))
    .response(true);
    assert_eq!(
        (s, b.message),
        (
            409,
            Message::One("Email này đã được dùng cho một công ty khác trên Trinity".into())
        )
    );
    let (s, b) = AppError::internal("ERROR: TRINITY_ROUTE_TAKEN: zalo_oa 9").response(false);
    assert_eq!(
        (s, b.error),
        (
            409,
            "Trang/kênh này đã được một công ty khác kết nối với Trinity".to_owned()
        )
    );
    // HttpError có chữ đó trong câu không bị dịch (bản TS bỏ qua HttpException).
    let (s, _) = AppError::Http(HttpError::bad_request("TRINITY_EMAIL_TAKEN")).response(false);
    assert_eq!(s, 400);
}

#[test]
fn thieu_cong_ty() {
    assert_eq!(AppError::MissingCompanyContext.response(false).0, 404);
    assert_eq!(AppError::MissingCompanyContext.response(true).0, 500);
}

#[test]
#[should_panic(expected = "Nest không có lớp lỗi cho mã 429")]
fn nest_khong_co_lop_429() {
    let _ = HttpError::nest(429, None);
}
