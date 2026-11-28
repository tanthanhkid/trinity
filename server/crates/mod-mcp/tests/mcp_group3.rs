//! Nhóm tool hộp thư và lời mời (M44c) so với hợp đồng đóng băng, không cần DB: đủ 7 tool, không có tool mật khẩu (tiêu chí của
//! issue), tool gửi ra ngoài/ghi không đánh dấu chỉ-đọc, kiểm đối số bằng chính schema đó.

use mod_mcp::frozen::{Frozen, TOOLS_JSON};
use serde_json::{Value, json};

const INBOX: [&str; 4] = [
    "list_unanswered_messages",
    "list_conversations",
    "get_conversation_messages",
    "reply_to_customer",
];
const INVITES: [&str; 3] = ["list_invitations", "create_invitation", "cancel_invitation"];
const WRITES: [&str; 3] = ["reply_to_customer", "create_invitation", "cancel_invitation"];

fn tools() -> Vec<Value> {
    let v: Value = serde_json::from_str(TOOLS_JSON).expect("tools.json hợp lệ");
    v["tools"].as_array().expect("tools là mảng").clone()
}

fn find(name: &str) -> Value {
    tools()
        .into_iter()
        .find(|t| t["name"] == name)
        .unwrap_or_else(|| panic!("hợp đồng thiếu tool {name}"))
}

#[test]
fn du_bay_tool_va_khong_co_tool_mat_khau() {
    let frozen = Frozen::embedded();
    for name in INBOX.iter().chain(INVITES.iter()) {
        assert!(frozen.tool(name).is_some(), "{name}");
    }
    assert_eq!(INBOX.len() + INVITES.len(), 7);
    let secret_words = ["password", "mat_khau", "matkhau", "secret", "token"];
    for name in INBOX.iter().chain(INVITES.iter()) {
        let t = find(name);
        assert!(!secret_words.iter().any(|w| name.contains(w)), "{name}");
        let props = t["inputSchema"]["properties"].as_object().expect("properties");
        for key in props.keys() {
            assert!(
                !secret_words.iter().any(|w| key.to_lowercase().contains(w)),
                "{name}.{key}"
            );
        }
    }
    // Không tool nào trong cả hợp đồng tên có mật khẩu và không có tool xoá ở hai nhóm này.
    for t in tools() {
        let n = t["name"].as_str().unwrap_or("");
        assert!(!n.contains("password") && !n.contains("mat_khau"), "{n}");
    }
    for name in INBOX.iter().chain(INVITES.iter()) {
        assert!(!name.starts_with("delete_") && !name.starts_with("remove_"), "{name}");
    }
}

#[test]
fn chi_doc_va_ghi_theo_hop_dong() {
    for name in INBOX.iter().chain(INVITES.iter()) {
        let t = find(name);
        let read_only = t["annotations"]["readOnlyHint"].as_bool().unwrap_or(false);
        assert_eq!(read_only, !WRITES.contains(name), "{name}");
        assert_eq!(t["annotations"]["destructiveHint"], json!(false), "{name}");
    }
}

#[test]
fn doi_so_theo_schema() {
    let frozen = Frozen::embedded();
    let ok = |name: &str, args: Value| frozen.tool(name).unwrap().check_input(&args).is_ok();
    // Hộp thư.
    assert!(ok("list_unanswered_messages", json!({})));
    assert!(ok(
        "list_unanswered_messages",
        json!({ "channel": "facebook_comment", "limit": 50 })
    ));
    assert!(!ok("list_unanswered_messages", json!({ "channel": "sms" })));
    assert!(!ok("list_unanswered_messages", json!({ "limit": 51 })));
    assert!(ok(
        "list_conversations",
        json!({ "channel": "zalo_oa", "search": "Lan", "limit": 1 })
    ));
    assert!(ok(
        "list_conversations",
        json!({ "contact_id": 12, "channel": "messenger" })
    ));
    for bad in [json!(0), json!(-1), json!("12"), json!(1.5), json!(2_147_483_648_i64)] {
        assert!(!ok("list_conversations", json!({ "contact_id": bad })), "{bad}");
    }
    assert!(!ok("list_conversations", json!({ "channel": "facebook_comment" })));
    assert!(!ok("list_conversations", json!({ "search": "x".repeat(101) })));
    assert!(ok("get_conversation_messages", json!({ "id": "messenger:12" })));
    assert!(!ok("get_conversation_messages", json!({})));
    assert!(!ok("get_conversation_messages", json!({ "id": "m" })));
    assert!(ok(
        "reply_to_customer",
        json!({ "id": "zalo_oa:5", "text": "dạ chào chị" })
    ));
    assert!(ok(
        "reply_to_customer",
        json!({ "id": "facebook_comment:3", "text": "ok", "comment_mode": "private", "confirmed_by_user": "ok gửi" })
    ));
    assert!(!ok("reply_to_customer", json!({ "id": "messenger:1", "text": "" })));
    assert!(!ok(
        "reply_to_customer",
        json!({ "id": "messenger:1", "text": "x".repeat(2001) })
    ));
    assert!(!ok("reply_to_customer", json!({ "text": "thiếu id" })));
    // Lời mời.
    assert!(ok("list_invitations", json!({ "all": true })));
    assert!(ok(
        "create_invitation",
        json!({ "email": "nv@congty.vn", "role_id": 3 })
    ));
    assert!(ok(
        "create_invitation",
        json!({ "email": "nv@congty.vn", "role_name": "Sales" })
    ));
    assert!(!ok("create_invitation", json!({ "email": "khong-phai-email" })));
    assert!(!ok("create_invitation", json!({ "role_id": 3 })));
    assert!(!ok(
        "create_invitation",
        json!({ "email": "nv@congty.vn", "role_id": 0 })
    ));
    assert!(ok("cancel_invitation", json!({ "invitation_id": 7 })));
    assert!(!ok("cancel_invitation", json!({})));
    assert!(!ok("cancel_invitation", json!({ "invitation_id": 2_147_483_648_i64 })));
}
