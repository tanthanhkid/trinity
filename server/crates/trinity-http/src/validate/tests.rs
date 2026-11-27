//! Golden từ Node (`server/contracts/dto/*.json`, sinh bởi `apps/monolith/src/__tests__/dto-validation-contract.spec.ts`).

use serde_json::Value;

use super::js::JsVal;
use super::*;

const VALIDATION: &str = include_str!("../../../../contracts/dto/validation.golden.json");
const TRANSFORM: &str = include_str!("../../../../contracts/dto/transform.golden.json");
const PARSE_INT: &str = include_str!("../../../../contracts/dto/parse-int.golden.json");

fn reg() -> &'static Registry {
    registry().unwrap_or_else(|e| panic!("schema.json không nạp được:\n{e}"))
}

#[test]
fn schema_nap_duoc_moi_luat_dieu_kien_transform() {
    let r = reg();
    assert!(r.classes.len() >= 20, "{}", r.classes.len());
}

#[test]
fn golden_33_dto_khop_validation_pipe() {
    let cases: Vec<Value> = serde_json::from_str(VALIDATION).unwrap();
    let dtos: std::collections::BTreeSet<&str> = cases.iter().filter_map(|c| c["dto"].as_str()).collect();
    assert_eq!(dtos.len(), 33, "{dtos:?}");
    let mut fails = Vec::new();
    for c in &cases {
        let mode = if c["mode"] == "strict" {
            Mode::Strict
        } else {
            Mode::Lenient
        };
        let name = c["dto"].as_str().unwrap();
        let got = match validate_value(name, &c["input"], mode) {
            Ok(v) => serde_json::json!({ "ok": v }),
            Err(e) => {
                let (status, body) = e.response(false);
                serde_json::json!({ "status": status, "message": body.message })
            }
        };
        if got != c["result"] {
            fails.push(format!(
                "{name} {} {}:\n  node: {}\n  rust: {}",
                c["mode"], c["probe"], c["result"], got
            ));
        }
    }
    assert!(
        fails.is_empty(),
        "{} / {} ca lệch:\n{}",
        fails.len(),
        cases.len(),
        fails.join("\n")
    );
}

#[test]
fn golden_moi_transform_khop() {
    let r = reg();
    let cases: Vec<Value> = serde_json::from_str(TRANSFORM).unwrap();
    let mut fails = Vec::new();
    for c in &cases {
        let class = r.class(c["dto"].as_str().unwrap()).unwrap();
        let prop = c["prop"].as_str().unwrap();
        let input = JsVal::from_contract(&c["input"]);
        let plain = if input == JsVal::Undefined {
            JsVal::Obj(vec![])
        } else {
            JsVal::Obj(vec![(prop.to_owned(), input)])
        };
        let inst = engine::plain_to_class(r, class, &plain);
        let got = inst.get(prop).to_contract();
        if got != c["output"] {
            fails.push(format!(
                "{}.{prop} input {}: node {} rust {}",
                c["dto"], c["input"], c["output"], got
            ));
        }
    }
    let props: std::collections::BTreeSet<String> =
        cases.iter().map(|c| format!("{}.{}", c["dto"], c["prop"])).collect();
    assert!(props.len() >= 38, "chỉ {} thuộc tính có @Transform", props.len());
    assert!(
        fails.is_empty(),
        "{} / {} ca lệch:\n{}",
        fails.len(),
        cases.len(),
        fails.join("\n")
    );
}

#[test]
fn golden_parse_int_pipe() {
    let cases: Vec<Value> = serde_json::from_str(PARSE_INT).unwrap();
    for c in &cases {
        let input = c["input"].as_str().unwrap();
        let got = match parse_int_param(input) {
            Ok(n) => serde_json::json!({ "ok": n }),
            Err(e) => serde_json::json!({ "status": 400, "message": e.body().message }),
        };
        assert_eq!(got, c["result"], "{input:?}");
    }
}

#[test]
fn che_do_theo_duong_dan() {
    assert_eq!(mode_for_path("/api/v1/users/5"), Mode::Lenient);
    assert_eq!(mode_for_path("/api/v1/employees"), Mode::Lenient);
    assert_eq!(mode_for_path("/api/v1/management/employees"), Mode::Strict);
    assert_eq!(mode_for_path("/api/v1/contacts"), Mode::Strict);
    // Như bản TS: so tiền tố thô, không theo ranh giới "/".
    assert_eq!(mode_for_path("/api/v1/users-x"), Mode::Lenient);
}

#[test]
fn query_string_nhu_express() {
    assert_eq!(
        query_to_json("page=2&tag=a&tag=b&ids[]=1&f[x]=y&q=a+b%20c"),
        serde_json::json!({ "page": "2", "tag": ["a", "b"], "ids": ["1"], "f": { "x": "y" }, "q": "a b c" })
    );
}

// Khung sinh bằng `cargo xtask gen-dto CreateDealDto QueryContactDto` (rút gọn trường không dùng trong test).
#[derive(Debug, Clone, serde::Deserialize)]
#[allow(dead_code)]
struct CreateDealDto {
    title: String,
    #[serde(default)]
    value: Option<i64>,
    #[serde(default)]
    status: Option<String>,
    assigned_to: i64,
}

impl Dto for CreateDealDto {
    const NAME: &'static str = "CreateDealDto";
}

#[derive(Debug, Clone, serde::Deserialize)]
#[allow(dead_code)]
struct QueryContactDto {
    #[serde(default)]
    page: Option<i64>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    search: Option<String>,
}

impl Dto for QueryContactDto {
    const NAME: &'static str = "QueryContactDto";
}

async fn body_json(resp: axum::response::Response) -> (u16, Value) {
    let status = resp.status().as_u16();
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn json_req(uri: &str, body: &str) -> axum::extract::Request {
    axum::http::Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_owned()))
        .unwrap()
}

#[tokio::test]
async fn extractor_body_strict_va_lenient() {
    use axum::extract::FromRequest;
    let ok = ValidJson::<CreateDealDto>::from_request(
        json_req("/api/v1/deals", r#"{"title":"A","assigned_to":3,"value":5}"#),
        &(),
    )
    .await
    .unwrap();
    assert_eq!((ok.0.title.as_str(), ok.0.assigned_to, ok.0.value), ("A", 3, Some(5)));

    let err = ValidJson::<CreateDealDto>::from_request(
        json_req("/api/v1/deals", r#"{"title":"A","assigned_to":3,"la":1}"#),
        &(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        body_json(err).await,
        (
            400,
            serde_json::json!({ "statusCode": 400, "message": ["property la should not exist"], "error": "Bad Request" })
        )
    );
    // Cùng DTO dưới tiền tố lenient: trường lạ bị bỏ.
    let ok = ValidJson::<CreateDealDto>::from_request(
        json_req("/api/v1/users/x", r#"{"title":"A","assigned_to":3,"la":1}"#),
        &(),
    )
    .await;
    assert!(ok.is_ok());
}

#[tokio::test]
async fn extractor_query_chuyen_so() {
    use axum::extract::FromRequestParts;
    let req = axum::http::Request::builder()
        .uri("/api/v1/contacts?page=2&limit=50&search=An")
        .body(())
        .unwrap();
    let (mut parts, ()) = req.into_parts();
    let q = ValidQuery::<QueryContactDto>::from_request_parts(&mut parts, &())
        .await
        .unwrap();
    assert_eq!(
        (q.0.page, q.0.limit, q.0.search.as_deref()),
        (Some(2), Some(50), Some("An"))
    );

    let req = axum::http::Request::builder()
        .uri("/api/v1/contacts?page=0&limit=abc")
        .body(())
        .unwrap();
    let (mut parts, ()) = req.into_parts();
    let err = ValidQuery::<QueryContactDto>::from_request_parts(&mut parts, &())
        .await
        .unwrap_err();
    let (status, body) = body_json(err).await;
    assert_eq!(status, 400);
    // NaN trượt cả min, max và isInt — như class-validator.
    assert_eq!(
        body["message"],
        serde_json::json!([
            "page must not be less than 1",
            "limit must not be greater than 200",
            "limit must not be less than 1",
            "limit must be an integer number"
        ])
    );
}

#[tokio::test]
async fn duong_dan_day_du_tu_original_uri_khi_nest_cat_tien_to() {
    use axum::extract::{FromRequest, OriginalUri};
    // Sau `nest("/api/v1/users", …)` axum cắt `uri()` còn "/x" ⇒ phải đọc `OriginalUri` để ra chế độ lenient.
    let mut req = json_req("/x", r#"{"title":"A","assigned_to":3,"la":1}"#);
    req.extensions_mut()
        .insert(OriginalUri("/api/v1/users/x".parse().unwrap()));
    assert!(ValidJson::<CreateDealDto>::from_request(req, &()).await.is_ok());
    let mut req = json_req("/x", r#"{"title":"A","assigned_to":3,"la":1}"#);
    req.extensions_mut()
        .insert(OriginalUri("/api/v1/deals/x".parse().unwrap()));
    assert!(ValidJson::<CreateDealDto>::from_request(req, &()).await.is_err());
}

#[tokio::test]
async fn body_rong_hoac_khong_phai_json_la_object_rong_nhu_express() {
    use axum::extract::FromRequest;
    let required = serde_json::json!({
        "statusCode": 400, "error": "Bad Request",
        "message": ["title must be shorter than or equal to 255 characters", "title must be a string", "Tên thương vụ không được để trống", "assigned_to phải là số nguyên", "Phải chọn sale phụ trách"]
    });
    let empty = |ct: Option<&str>, body: &str| {
        let mut b = axum::http::Request::builder().method("POST").uri("/api/v1/deals");
        if let Some(ct) = ct {
            b = b.header("content-type", ct);
        }
        b.body(axum::body::Body::from(body.to_owned())).unwrap()
    };
    for req in [
        empty(Some("application/json"), ""),
        empty(Some("application/json"), "  "),
        empty(None, r#"{"title":"A"}"#),
        empty(Some("text/plain"), "x"),
    ] {
        let err = ValidJson::<CreateDealDto>::from_request(req, &()).await.unwrap_err();
        let (status, body) = body_json(err).await;
        assert_eq!(status, 400);
        // Câu lỗi của class-validator (trường bắt buộc), không phải câu của axum về Content-Type.
        assert_eq!(body["message"], required["message"], "{body}");
    }
    // JSON hỏng hoặc gốc không phải `{`/`[` ⇒ 400.
    for bad in ["{oops", "5", "\"x\""] {
        let err = ValidJson::<CreateDealDto>::from_request(json_req("/api/v1/deals", bad), &())
            .await
            .unwrap_err();
        assert_eq!(body_json(err).await.0, 400, "{bad}");
    }
}

#[tokio::test]
async fn so_nguyen_lon_ghi_integer_va_ngoai_khoang_la_400_khong_phai_500() {
    use axum::extract::FromRequest;
    // 2^53+1 (JS làm tròn về 2^53) vẫn ghi dạng số nguyên, không float.
    let ok = ValidJson::<CreateDealDto>::from_request(
        json_req(
            "/api/v1/deals",
            r#"{"title":"A","assigned_to":9007199254740993,"value":4611686018427387904}"#,
        ),
        &(),
    )
    .await
    .unwrap();
    assert_eq!(
        (ok.0.assigned_to, ok.0.value),
        (9_007_199_254_740_992, Some(4_611_686_018_427_387_904))
    );
    // Ngoài khoảng i64 ⇒ lỗi của dữ liệu vào (400), không phải lỗi máy chủ.
    for v in ["1e30", "10000000000000000000000", "9223372036854775808"] {
        let err = ValidJson::<CreateDealDto>::from_request(
            json_req("/api/v1/deals", &format!(r#"{{"title":"A","assigned_to":{v}}}"#)),
            &(),
        )
        .await
        .unwrap_err();
        assert_eq!(body_json(err).await.0, 400, "{v}");
    }
}

#[test]
fn query_string_nhu_qs() {
    let cases: &[(&str, Value)] = &[
        ("a=1&a=2", serde_json::json!({ "a": ["1", "2"] })),
        ("a[]=1&a[]=2", serde_json::json!({ "a": ["1", "2"] })),
        ("a[0]=x&a[1]=y", serde_json::json!({ "a": ["x", "y"] })),
        ("a[2]=x", serde_json::json!({ "a": ["x"] })),
        ("a[21]=x", serde_json::json!({ "a": { "21": "x" } })),
        ("a[b]=1&a[c]=2", serde_json::json!({ "a": { "b": "1", "c": "2" } })),
        ("a[b][c]=1", serde_json::json!({ "a": { "b": { "c": "1" } } })),
        ("=x&b=1", serde_json::json!({ "b": "1" })),
        (
            "a[b][c][d][e][f][g]=1",
            serde_json::json!({ "a": { "b": { "c": { "d": { "e": { "f": { "[g]": "1" } } } } } } }),
        ),
        (
            "a[0][b]=1&a[1][b]=2",
            serde_json::json!({ "a": [{ "b": "1" }, { "b": "2" }] }),
        ),
        ("[a]=1", serde_json::json!({ "a": "1" })),
        ("a[b=1", serde_json::json!({ "a": { "[b": "1" } })),
        ("a=&b", serde_json::json!({ "a": "", "b": "" })),
        ("0=a&1=b", serde_json::json!({ "0": "a", "1": "b" })),
    ];
    for (q, want) in cases {
        assert_eq!(&query_to_json(q), want, "{q}");
    }
}

#[test]
fn array_unique_co_nan_khong_unique_nhu_class_validator() {
    use super::js::JsVal;
    let rule = super::rules::Rule::ArrayUnique;
    let n = JsVal::Num;
    assert!(rule.check(&JsVal::Arr(vec![n(1.0), n(2.0)])));
    assert!(!rule.check(&JsVal::Arr(vec![n(1.0), n(1.0)])));
    assert!(!rule.check(&JsVal::Arr(vec![n(f64::NAN)])), "indexOf(NaN) = -1 ≠ 0");
    assert!(!rule.check(&JsVal::Arr(vec![n(f64::NAN), n(f64::NAN)])));
    assert!(
        rule.check(&JsVal::Arr(vec![JsVal::Obj(vec![]), JsVal::Obj(vec![])])),
        "đối tượng so theo tham chiếu"
    );
}

#[test]
fn is_email_dau_nhay_va_do_dai_theo_validator_js() {
    use super::rules::{is_email_for_test, validator_len_for_test};
    // Đối chiếu validator 13.15.26 chạy thật: `"a"@b.co` true, `"a@b.co` false, `"@b.co` true.
    assert!(is_email_for_test("\"a\"@b.co"));
    assert!(!is_email_for_test("\"a@b.co"));
    assert!(is_email_for_test("\"@b.co"));
    // Trừ MỌI U+FE0E/U+FE0F: "a" FE0F FE0F "b" FE0E = 2 ký tự; FE0F "a" "b" = 2.
    assert_eq!(validator_len_for_test("a\u{FE0F}\u{FE0F}b\u{FE0E}"), 2);
    assert_eq!(validator_len_for_test("\u{FE0F}ab"), 2);
    assert_eq!(validator_len_for_test("a😀b"), 3);
}

#[test]
fn body_mang_lam_nhu_validation_pipe_cua_nest() {
    // Golden `array_body*` trong validation.golden.json (sinh bởi ValidationPipe thật) được `golden_20_dto_...` chạy.
    let v = validate_value("SendNotificationDto", &serde_json::json!([1, 2]), Mode::Strict).unwrap_err();
    let (status, body) = v.response(false);
    assert_eq!(status, 400);
    let msgs = serde_json::to_string(&body.message).unwrap();
    assert!(
        msgs.contains("property 0 should not exist") && msgs.contains("property 1 should not exist"),
        "{msgs}"
    );
}

#[test]
fn type_la_bi_tu_choi_khi_nap_schema() {
    let base = |ty: &str| {
        format!(
            r#"{{"D":{{"declared":["x"],"validated":["x"],"defaults":{{}},"fields":{{"x":{{"type":{ty},"rules":[],"transforms":[]}}}}}}}}"#
        )
    };
    assert!(Registry::from_json(&base("\"Number\"")).is_ok());
    assert!(Registry::from_json(&base("null")).is_ok());
    assert!(Registry::from_json(&base("\"Array\"")).is_ok());
    let e = Registry::from_json(&base("\"Date\"")).unwrap_err();
    assert!(e.contains("D.x") && e.contains("Date"), "{e}");
    assert!(Registry::from_json(&base("\"Symbol\"")).is_err());
    assert!(Registry::from_json(&base("{\"weird\":1}")).is_err());
}
