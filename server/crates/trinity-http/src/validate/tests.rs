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
fn golden_20_dto_khop_validation_pipe() {
    let cases: Vec<Value> = serde_json::from_str(VALIDATION).unwrap();
    let dtos: std::collections::BTreeSet<&str> = cases.iter().filter_map(|c| c["dto"].as_str()).collect();
    assert_eq!(dtos.len(), 20, "{dtos:?}");
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
