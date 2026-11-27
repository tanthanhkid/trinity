//! Kiểm dữ liệu vào của 4 DTO M06 đối chiếu `ValidationPipe` thật (golden sinh bởi
//! `apps/monolith/src/__tests__/settings-dto-golden.spec.ts`): cùng câu lỗi, cùng thứ tự; hợp lệ thì cùng giá trị nhận vào.

use mod_settings::{
    validate_org_features, validate_update_departments, validate_update_notification_sound, validate_update_option,
};
use serde_json::Value;
use trinity_kernel::error::{HttpError, Message};

fn messages(e: &HttpError) -> Vec<String> {
    match e.body().message {
        Message::Many(v) => v,
        Message::One(s) => vec![s],
    }
}

#[test]
fn bon_dto_khop_validation_pipe() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("fixtures/dto.json")).unwrap();
    assert!(cases.len() > 70);
    for c in &cases {
        let (dto, payload, result) = (c["dto"].as_str().unwrap(), &c["payload"], &c["result"]);
        let label = format!("{dto} {payload}");
        let outcome: Result<Value, HttpError> = match dto {
            "UpdateOptionDto" => validate_update_option(payload).map(|o| {
                let mut m = serde_json::Map::new();
                if let Some(l) = o.label {
                    m.insert("label".into(), l.into());
                }
                if let Some(n) = o.sort_order {
                    m.insert("sort_order".into(), n.into());
                }
                if let Some(b) = o.is_active {
                    m.insert("is_active".into(), b.into());
                }
                if let Some(x) = o.metadata {
                    m.insert("metadata".into(), x);
                }
                Value::Object(m)
            }),
            "UpdateNotificationSoundDto" => {
                validate_update_notification_sound(payload).map(|s| serde_json::json!({ "sound_id": s }))
            }
            "UpdateDepartmentsDto" => {
                validate_update_departments(payload).map(|d| serde_json::json!({ "departments": d }))
            }
            "UpdateOrgFeaturesDto" => validate_org_features(payload).map(|f| {
                let mut m = serde_json::Map::new();
                for k in mod_settings::validate::ORG_FEATURE_DTO_KEYS {
                    if let Some(v) = f.get(k) {
                        m.insert(k.to_owned(), v.into());
                    }
                }
                Value::Object(m)
            }),
            other => panic!("DTO lạ {other}"),
        };
        match (outcome, result.get("ok")) {
            (Ok(got), Some(ok)) => {
                // Node trả nguyên thân cho thân không phải object (Nest không biến đổi): chỉ so khi là object.
                if let Some(want) = ok.as_object() {
                    // `null` của khoá org-features/is_active… Node giữ, Rust coi như vắng: so phần Rust có.
                    for (k, v) in got.as_object().unwrap() {
                        assert_eq!(want.get(k), Some(v), "{label}: khoá {k}");
                    }
                    // Mọi khoá hợp lệ khác null mà Node giữ thì Rust cũng phải giữ.
                    for (k, v) in want.iter().filter(|(_, v)| !v.is_null()) {
                        assert_eq!(got.get(k), Some(v), "{label}: thiếu khoá {k}");
                    }
                }
            }
            (Err(e), None) => {
                assert_eq!(e.status(), 400, "{label}");
                let want: Vec<String> = result["message"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|m| m.as_str().unwrap().to_owned())
                    .collect();
                assert_eq!(messages(&e), want, "{label}");
            }
            (Ok(_), None) => panic!("{label}: Rust nhận nhưng Node từ chối {result}"),
            (Err(e), Some(_)) => panic!("{label}: Rust từ chối {:?} nhưng Node nhận", messages(&e)),
        }
    }
}
