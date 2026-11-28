//! Test thân tool Fanpage bằng port giả (không DB): luật xác nhận, bản xem trước trước khi gửi, ánh xạ trường, tên tool khớp
//! hợp đồng đóng băng và không có tool xoá.

use std::sync::Mutex;

use serde_json::{Map, Value, json};

use super::*;
use crate::frozen::TOOLS_JSON;

const TOOLS: [&str; 16] = [
    "list_facebook_comments",
    "list_facebook_comment_rules",
    "create_comment_rule",
    "update_comment_rule",
    "test_comment_rule",
    "list_chat_links",
    "create_chat_link",
    "get_page_admin_guide",
    "list_message_flows",
    "create_message_flow",
    "update_message_flow",
    "list_messenger_broadcasts",
    "send_messenger_broadcast",
    "update_messenger_broadcast",
    "cancel_messenger_broadcast",
    "cancel_scheduled_post",
];

fn env() -> Env<'static> {
    Env {
        company: CompanyRef::DEFAULT,
        user_id: 7,
        base_url: "https://crm.example.test",
        now: DateTime::parse_from_rfc3339("2026-11-27T03:00:00Z")
            .unwrap()
            .with_timezone(&Utc),
    }
}

fn data(o: Result<ToolOutput, ToolError>) -> Value {
    o.unwrap().structured["data"].clone()
}

fn user_msg(e: ToolError) -> String {
    match e {
        ToolError::User(m) => m,
        other => panic!("cần ToolError::User, được {other:?}"),
    }
}

// ------------------------------------------------------------------ port giả

#[derive(Default)]
struct FakePages;

impl PagesPort for FakePages {
    fn pages(&self, _c: CompanyRef) -> PortFut<'_, Vec<PageRef>> {
        Box::pin(async {
            Ok(vec![PageRef {
                page_id: "111".into(),
                name: "Shop A".into(),
                is_active: true,
            }])
        })
    }
}

#[derive(Default)]
struct FakeBroadcasts {
    log: Mutex<Vec<String>>,
    status: String,
}

impl FakeBroadcasts {
    fn with_status(status: &str) -> Self {
        Self {
            log: Mutex::default(),
            status: status.into(),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    fn note(&self, s: &str) {
        self.log.lock().unwrap().push(s.to_owned());
    }

    fn view(&self, status: &str) -> Value {
        json!({
            "id": 5, "name": "Khai giảng", "page_id": "111", "page_name": "Shop A", "text": "Chào {ten}",
            "status": status, "scheduled_at": "2026-11-28T02:00:00Z", "total": 0, "sent": 0, "failed": 0, "skipped": 0,
            "audience": {},
        })
    }
}

impl BroadcastsPort for FakeBroadcasts {
    fn list(&self, _c: CompanyRef, _l: i64) -> PortFut<'_, Vec<Value>> {
        Box::pin(async move { Ok(vec![self.view("done")]) })
    }
    fn recipients(&self, _c: CompanyRef, _id: i32, _l: i64) -> PortFut<'_, Vec<Value>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn get(&self, _c: CompanyRef, _id: i32) -> PortFut<'_, Value> {
        Box::pin(async move { Ok(self.view(&self.status)) })
    }
    fn validate(&self, _c: CompanyRef, _i: &Value, _p: bool) -> PortFut<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    fn check_send_time(&self, at: Option<DateTime<Utc>>) -> Result<(), ToolError> {
        match at {
            Some(t) if t > env().now + chrono::Duration::days(7) => {
                Err(ToolError::User("Hẹn tối đa 7 ngày tới".into()))
            }
            _ => Ok(()),
        }
    }
    fn preview<'a>(&'a self, _c: CompanyRef, _p: &'a str, _a: &'a Value) -> PortFut<'a, Value> {
        Box::pin(async { Ok(json!({ "eligible": 12, "outside_window": 3, "sample": ["An", "Bình"] })) })
    }
    fn create<'a>(&'a self, _c: CompanyRef, _u: i32, _i: &'a Value, source: &'a str) -> PortFut<'a, Value> {
        Box::pin(async move {
            self.note(&format!("create:{source}"));
            Ok(self.view("draft"))
        })
    }
    fn update(&self, _c: CompanyRef, _id: i32, input: Map<String, Value>) -> PortFut<'_, Value> {
        Box::pin(async move {
            self.note(&format!("update:{}", input.len()));
            Ok(self.view("draft"))
        })
    }
    fn send(&self, _c: CompanyRef, _id: i32, at: Option<DateTime<Utc>>) -> PortFut<'_, Value> {
        Box::pin(async move {
            self.note(&format!("send:{}", at.is_some()));
            Ok(self.view("scheduled"))
        })
    }
    fn kick(&self) {
        self.note("kick");
    }
    fn cancel_pending(&self, _c: CompanyRef, _id: i32) -> PortFut<'_, Value> {
        Box::pin(async move {
            self.note("cancel");
            Ok(self.view("cancelled"))
        })
    }
}

struct FakeComments {
    created: Mutex<Vec<Map<String, Value>>>,
}

impl CommentsPort for FakeComments {
    fn list_comments(&self, _c: CompanyRef, _q: CommentQuery) -> PortFut<'_, Vec<Value>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn list_rules(&self, _c: CompanyRef) -> PortFut<'_, Vec<Value>> {
        Box::pin(async {
            Ok(vec![json!({
                "id": 3, "name": "Giá", "page_id": null, "post_id": null, "keywords": ["giá"], "exclude_keywords": [],
                "public_replies": ["Đã nhắn riêng"], "private_reply": null, "hide_if_phone": false, "once_per_user": true,
                "mode": "test", "is_active": true, "position": 0,
            })])
        })
    }
    fn create_rule(&self, _c: CompanyRef, _u: i32, input: Map<String, Value>) -> PortFut<'_, Value> {
        Box::pin(async move {
            self.created.lock().unwrap().push(input.clone());
            let mut v = Value::Object(input);
            v["id"] = json!(9);
            Ok(v)
        })
    }
    fn update_rule(&self, _c: CompanyRef, _id: i32, input: Map<String, Value>) -> PortFut<'_, Value> {
        Box::pin(async move {
            self.created.lock().unwrap().push(input.clone());
            Ok(Value::Object(input))
        })
    }
    fn dry_run(&self, _c: CompanyRef, _i: Value) -> PortFut<'_, Value> {
        Box::pin(async { Ok(json!({ "matched_rule": null })) })
    }
    fn normalize_post_id(&self, raw: &str, _p: Option<&str>) -> Result<Option<String>, ToolError> {
        Ok(Some(raw.to_owned()))
    }
}

fn ports(b: FakeBroadcasts) -> (Arc<FakeBroadcasts>, FanpagePorts) {
    let b = Arc::new(b);
    let p = FanpagePorts {
        pages: Some(Arc::new(FakePages)),
        broadcasts: Some(b.clone()),
        ..FanpagePorts::default()
    };
    (b, p)
}

// ------------------------------------------------------------------ thuần

#[test]
fn loi_dong_y() {
    for yes in [
        "ok gửi đi",
        "Được, làm vậy",
        "OK",
        "khỏi hỏi lại",
        "không cần thêm gì, ok",
    ] {
        assert!(is_user_confirmation(Some(&json!(yes))), "{yes}");
    }
    for no in ["", "không", "chưa, sửa lại", "ok nhưng thêm câu này", "gửi đi"] {
        assert!(!is_user_confirmation(Some(&json!(no))), "{no}");
    }
    assert!(!is_user_confirmation(None));
    assert!(!is_user_confirmation(Some(&json!(5))));
}

#[test]
fn gio_viet_nam() {
    let t = parse_scheduled_at(Some(&json!("2026-10-20T09:00"))).unwrap().unwrap();
    assert_eq!(t.to_rfc3339(), "2026-10-20T02:00:00+00:00");
    assert_eq!(vn_when(t), "09:00 Thứ Ba 20/10/2026 (giờ Việt Nam)");
    assert_eq!(parse_scheduled_at(Some(&json!("2026-10-20 09:00"))).unwrap(), Some(t));
    assert_eq!(parse_scheduled_at(Some(&json!("  "))).unwrap(), None);
    assert_eq!(parse_scheduled_at(None).unwrap(), None);
    assert!(user_msg(parse_scheduled_at(Some(&json!("mai 9h"))).unwrap_err()).contains("không đúng dạng"));
    assert_eq!(
        vn_iso(Some(&json!("2026-10-12T11:26:05Z"))).as_deref(),
        Some("2026-10-12T18:26:05+07:00")
    );
    assert_eq!(vn_iso(Some(&json!("hỏng"))), None);
}

#[test]
fn khoang_ngay() {
    let now = env().now;
    let (f, t, label) = activity_range(None, None, now).unwrap();
    assert_eq!(label, "2026-11-27");
    assert_eq!(f.to_rfc3339(), "2026-11-26T17:00:00+00:00");
    assert_eq!(t - f, chrono::Duration::days(1));
    let (_, _, l2) = activity_range(Some(&json!("2026-11-01")), Some(&json!("2026-11-03")), now).unwrap();
    assert_eq!(l2, "2026-11-01 → 2026-11-03");
    assert!(activity_range(Some(&json!("2026-11-03")), Some(&json!("2026-11-01")), now).is_err());
    assert!(activity_range(Some(&json!("2026-01-01")), Some(&json!("2026-11-01")), now).is_err());
    assert!(activity_range(Some(&json!("27/11/2026")), None, now).is_err());
}

#[test]
fn doi_tuong_nhan_va_danh_sach_sach() {
    let a = clean_audience(Some(&json!([1, 1, 0, -2, 3, "x", 2147483648_i64])), Some(&json!([])));
    assert_eq!(a, json!({ "source_ids": [1, 3] }));
    assert_eq!(clean_audience(None, None), json!({}));
    let l = clean_list(&[json!(" a "), json!("a"), json!(""), json!("b")]);
    assert_eq!(l, vec!["a".to_owned(), "b".to_owned()]);
}

#[test]
fn dang_ky_dung_16_tool_khong_co_xoa() {
    let mut r = ToolRegistry::new();
    register_fanpage(&mut r, Arc::new(FanpagePorts::default()));
    assert_eq!(r.len(), 16);
    let frozen: Value = serde_json::from_str(TOOLS_JSON).unwrap();
    let names: Vec<&str> = frozen["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    for n in TOOLS {
        let spec = r.get(n).unwrap_or_else(|| panic!("thiếu {n}"));
        assert!(names.contains(&n), "{n} không có trong hợp đồng");
        let read_only = n.starts_with("list_") || n == "test_comment_rule" || n == "get_page_admin_guide";
        assert_eq!(spec.scope.is_none(), read_only, "{n}: scope");
        assert!(!n.contains("delete") && !n.contains("remove"), "{n}");
    }
    assert_eq!(r.get("cancel_scheduled_post").unwrap().permissions, &["social.post"]);
    assert_eq!(
        r.get("send_messenger_broadcast").unwrap().permissions,
        &["integrations.webhooks"]
    );
}

// ------------------------------------------------------------------ hướng dẫn quản trị viên Page

struct FakeGuide(Mutex<Vec<(String, Option<String>, Option<String>)>>);

impl AdminGuidePort for FakeGuide {
    fn compose<'a>(
        &'a self,
        _c: CompanyRef,
        page_id: &'a str,
        recipient: Option<String>,
        note: Option<String>,
    ) -> PortFut<'a, Value> {
        self.0
            .lock()
            .unwrap()
            .push((page_id.to_owned(), recipient.clone(), note.clone()));
        Box::pin(async move { Ok(json!({ "page_id": page_id, "text": "Chào", "sent": false })) })
    }
}

#[tokio::test]
async fn huong_dan_quan_tri_page_chi_soan_khong_gui() {
    let g = Arc::new(FakeGuide(Mutex::default()));
    let p = FanpagePorts {
        pages: Some(Arc::new(FakePages)),
        admin_guide: Some(g.clone()),
        ..FanpagePorts::default()
    };
    // Một Page đang bật ⇒ không cần page_id; khoảng trắng ở tên/lời nhắn bị bỏ.
    let d = data(get_page_admin_guide(&p, &json!({ "recipient": " Chị Lan ", "note": "  " }), &env()).await);
    assert_eq!(d["sent"], json!(false));
    assert!(d["next_step"].as_str().unwrap().contains("Trinity không gửi gì"));
    assert_eq!(
        g.0.lock().unwrap().as_slice(),
        &[("111".to_owned(), Some("Chị Lan".to_owned()), None)]
    );
    // Có page_id thì dùng đúng page_id đó.
    data(get_page_admin_guide(&p, &json!({ "page_id": "999" }), &env()).await);
    assert_eq!(g.0.lock().unwrap()[1].0, "999");
    // Port vắng ⇒ báo chưa có tính năng.
    let e = get_page_admin_guide(&FanpagePorts::default(), &json!({}), &env())
        .await
        .err()
        .unwrap();
    assert!(user_msg(e).contains("hướng dẫn quản trị viên Page"));
}

struct TwoPages;

impl PagesPort for TwoPages {
    fn pages(&self, _c: CompanyRef) -> PortFut<'_, Vec<PageRef>> {
        Box::pin(async {
            Ok(vec![
                PageRef {
                    page_id: "111".into(),
                    name: "Shop A".into(),
                    is_active: true,
                },
                PageRef {
                    page_id: "222".into(),
                    name: "Shop B".into(),
                    is_active: false,
                },
            ])
        })
    }
}

#[tokio::test]
async fn huong_dan_quan_tri_page_khong_tu_chon_khi_co_page_da_ngat() {
    let g = Arc::new(FakeGuide(Mutex::default()));
    let p = FanpagePorts {
        pages: Some(Arc::new(TwoPages)),
        admin_guide: Some(g.clone()),
        ..FanpagePorts::default()
    };
    // Một Page bật + một Page đã ngắt (chính là Page cần nối lại) ⇒ không đoán, liệt kê cả Page đã ngắt.
    let e = get_page_admin_guide(&p, &json!({}), &env()).await.err().unwrap();
    let m = user_msg(e);
    assert!(m.contains("Shop B = 222 (đã ngắt)"), "{m}");
    assert!(g.0.lock().unwrap().is_empty());
}

// ------------------------------------------------------------------ gửi hàng loạt

#[tokio::test]
async fn gui_hang_loat_xem_truoc_khong_gui() {
    let (b, p) = ports(FakeBroadcasts::with_status("draft"));
    let args = json!({ "name": "Khai giảng", "text": "Chào {ten}" });
    let d = data(send_messenger_broadcast(&p, &args, &env()).await);
    assert_eq!(d["started"], json!(false));
    assert_eq!(d["preview"]["eligible"], json!(12));
    assert_eq!(d["preview"]["outside_window"], json!(3));
    assert_eq!(d["preview"]["when"], json!("Gửi ngay"));
    assert!(d["next_step"].as_str().unwrap().starts_with("CHƯA GỬI"));
    assert!(
        b.calls().is_empty(),
        "chưa có lời đồng ý thì không được tạo/gửi: {:?}",
        b.calls()
    );
    // Lời không phải đồng ý cũng không gửi.
    let args = json!({ "name": "x", "text": "y", "confirmed_by_user": "khoan, sửa lại" });
    let d = data(send_messenger_broadcast(&p, &args, &env()).await);
    assert_eq!(d["started"], json!(false));
    assert!(b.calls().is_empty());
}

#[tokio::test]
async fn gui_hang_loat_co_dong_y_gui_va_danh_thuc_job() {
    let (b, p) = ports(FakeBroadcasts::with_status("draft"));
    let args = json!({ "name": "Khai giảng", "text": "Chào", "confirmed_by_user": "ok gửi đi" });
    let d = data(send_messenger_broadcast(&p, &args, &env()).await);
    assert_eq!(d["started"], json!(true));
    assert_eq!(d["expected_recipients"], json!(12));
    assert_eq!(b.calls(), vec!["create:mcp", "send:false", "kick"]);
    // Hẹn giờ thì không kick.
    let (b, p) = ports(FakeBroadcasts::with_status("draft"));
    let args = json!({ "name": "a", "text": "b", "scheduled_at": "2026-11-28T09:00", "confirmed_by_user": "ok" });
    send_messenger_broadcast(&p, &args, &env()).await.unwrap();
    assert_eq!(b.calls(), vec!["create:mcp", "send:true"]);
}

#[tokio::test]
async fn gui_hang_loat_hen_qua_7_ngay_bi_tu_choi_truoc_xem_truoc() {
    let (b, p) = ports(FakeBroadcasts::with_status("draft"));
    let args = json!({ "name": "a", "text": "b", "scheduled_at": "2026-12-30T09:00" });
    let e = send_messenger_broadcast(&p, &args, &env()).await.err().unwrap();
    assert!(user_msg(e).contains("7 ngày"));
    assert!(b.calls().is_empty());
}

#[tokio::test]
async fn gui_hang_loat_nhieu_page_bat_chon_page_id() {
    struct Two;
    impl PagesPort for Two {
        fn pages(&self, _c: CompanyRef) -> PortFut<'_, Vec<PageRef>> {
            Box::pin(async {
                Ok(vec![
                    PageRef {
                        page_id: "1".into(),
                        name: "A".into(),
                        is_active: true,
                    },
                    PageRef {
                        page_id: "2".into(),
                        name: "B".into(),
                        is_active: true,
                    },
                ])
            })
        }
    }
    let (_, mut p) = ports(FakeBroadcasts::with_status("draft"));
    p.pages = Some(Arc::new(Two));
    let e = send_messenger_broadcast(&p, &json!({ "name": "a", "text": "b" }), &env())
        .await
        .err()
        .unwrap();
    assert!(user_msg(e).contains("A = 1; B = 2"));
}

#[tokio::test]
async fn sua_va_huy_can_dong_y() {
    let (b, p) = ports(FakeBroadcasts::with_status("scheduled"));
    let d = data(update_messenger_broadcast(&p, &json!({ "broadcast_id": 5, "text": "mới" }), &env()).await);
    assert_eq!(d["saved"], json!(false));
    assert!(d["preview"]["when"].as_str().unwrap().starts_with("Giữ giờ hẹn"));
    let d = data(cancel_messenger_broadcast(&p, &json!({ "broadcast_id": 5 }), &env()).await);
    assert_eq!(d["cancelled"], json!(false));
    assert!(b.calls().is_empty());
    let d = data(
        cancel_messenger_broadcast(&p, &json!({ "broadcast_id": 5, "confirmed_by_user": "đồng ý" }), &env()).await,
    );
    assert_eq!(d["cancelled"], json!(true));
    assert_eq!(d["status"], json!("cancelled"));
    let d = data(
        update_messenger_broadcast(
            &p,
            &json!({ "broadcast_id": 5, "text": "mới", "confirmed_by_user": "ok" }),
            &env(),
        )
        .await,
    );
    assert_eq!(d["saved"], json!(true));
    assert_eq!(b.calls(), vec!["cancel", "update:1"]);
}

#[tokio::test]
async fn khong_sua_khong_huy_luot_da_chay() {
    let (_, p) = ports(FakeBroadcasts::with_status("done"));
    let e = update_messenger_broadcast(&p, &json!({ "broadcast_id": 5, "text": "x" }), &env())
        .await
        .err()
        .unwrap();
    assert!(user_msg(e).contains("đã xong"));
    let e = cancel_messenger_broadcast(&p, &json!({ "broadcast_id": 5 }), &env())
        .await
        .err()
        .unwrap();
    assert!(user_msg(e).contains("chỉ huỷ được lượt đang chờ"));
    let e = update_messenger_broadcast(
        &p,
        &json!({ "broadcast_id": 5, "scheduled_at": "2026-11-28T09:00", "send_now": true }),
        &env(),
    )
    .await
    .err()
    .unwrap();
    assert!(user_msg(e).contains("Chọn một"));
}

#[tokio::test]
async fn danh_sach_gui_hang_loat_doi_gio_viet_nam() {
    let (_, p) = ports(FakeBroadcasts::with_status("done"));
    let d = data(list_messenger_broadcasts(&p, &json!({}), &env()).await);
    let b = &d["broadcasts"][0];
    assert_eq!(b["status_text"], json!("đã xong"));
    assert_eq!(b["scheduled_at"], json!("09:00 Thứ Bảy 28/11/2026 (giờ Việt Nam)"));
    assert_eq!(
        b["url"],
        json!("https://crm.example.test/connections?muc=facebook&xem=gui-hang-loat&luot=5")
    );
}

#[tokio::test]
async fn port_vang_bao_chua_co_tinh_nang() {
    let p = FanpagePorts::default();
    let e = list_messenger_broadcasts(&p, &json!({}), &env()).await.err().unwrap();
    assert!(user_msg(e).starts_with("Máy chủ này chưa có tính năng gửi tin hàng loạt"));
    let e = list_chat_links(&p, &json!({}), &env()).await.err().unwrap();
    assert!(user_msg(e).contains("link mở chat"));
}

// ------------------------------------------------------------------ luật bình luận

fn comments_ports() -> (Arc<FakeComments>, FanpagePorts) {
    let c = Arc::new(FakeComments {
        created: Mutex::default(),
    });
    let p = FanpagePorts {
        pages: Some(Arc::new(FakePages)),
        comments: Some(c.clone()),
        ..FanpagePorts::default()
    };
    (c, p)
}

#[tokio::test]
async fn luat_thu_ghi_thang_luat_that_can_dong_y() {
    let (c, p) = comments_ports();
    // Mặc định mode test ⇒ ghi thẳng.
    let args = json!({ "name": "Giá", "public_replies": ["Dạ đã nhắn riêng"] });
    let d = data(create_comment_rule(&p, &args, &env()).await);
    assert_eq!(d["saved"], json!(true));
    assert_eq!(c.created.lock().unwrap().len(), 1);
    // live + bật mà thiếu đồng ý ⇒ không lưu.
    let args = json!({ "name": "Giá", "public_replies": ["x"], "mode": "live" });
    let d = data(create_comment_rule(&p, &args, &env()).await);
    assert_eq!(d["saved"], json!(false));
    assert_eq!(c.created.lock().unwrap().len(), 1);
    let args = json!({ "name": "Giá", "public_replies": ["x"], "mode": "live", "confirmed_by_user": "ok bật đi" });
    assert_eq!(data(create_comment_rule(&p, &args, &env()).await)["saved"], json!(true));
    assert_eq!(c.created.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn luat_can_it_nhat_mot_viec_va_page_phai_co() {
    let (_, p) = comments_ports();
    let e = create_comment_rule(&p, &json!({ "name": "x" }), &env())
        .await
        .err()
        .unwrap();
    assert!(user_msg(e).contains("ít nhất một việc"));
    let e = create_comment_rule(
        &p,
        &json!({ "name": "x", "hide_if_phone": true, "page_id": "999" }),
        &env(),
    )
    .await
    .err()
    .unwrap();
    assert!(user_msg(e).contains("page_id = 999"));
    let e = create_comment_rule(
        &p,
        &json!({ "name": "x", "hide_if_phone": true, "page_id": "111", "post_link": "222_5" }),
        &env(),
    )
    .await
    .err()
    .unwrap();
    assert!(user_msg(e).contains("Fanpage khác"));
}

#[tokio::test]
async fn sua_luat_chi_doi_ten_khong_can_dong_y_con_bat_live_thi_can() {
    let (c, p) = comments_ports();
    let d = data(update_comment_rule(&p, &json!({ "rule_id": 3, "name": "Giá mới" }), &env()).await);
    assert_eq!(d["saved"], json!(true));
    // Chuyển sang live cần đồng ý.
    let d = data(update_comment_rule(&p, &json!({ "rule_id": 3, "mode": "live" }), &env()).await);
    assert_eq!(d["saved"], json!(false));
    assert_eq!(c.created.lock().unwrap().len(), 1);
    // Tắt luật ghi thẳng.
    let d = data(update_comment_rule(&p, &json!({ "rule_id": 3, "mode": "live", "active": false }), &env()).await);
    assert_eq!(d["saved"], json!(true));
    let e = update_comment_rule(&p, &json!({ "rule_id": 3 }), &env())
        .await
        .err()
        .unwrap();
    assert!(user_msg(e).contains("Không có trường nào"));
    let e = update_comment_rule(&p, &json!({ "rule_id": 404, "name": "x" }), &env())
        .await
        .err()
        .unwrap();
    assert!(user_msg(e).contains("rule_id = 404"));
    // Bỏ hết việc của luật đang bật bị chặn.
    let e = update_comment_rule(&p, &json!({ "rule_id": 3, "public_replies": [] }), &env())
        .await
        .err()
        .unwrap();
    assert!(user_msg(e).contains("không còn việc nào"));
}

#[tokio::test]
async fn thu_luat_khong_khop() {
    let (_, p) = comments_ports();
    let d = data(test_comment_rule(&p, &json!({ "message": "giá bao nhiêu" }), &env()).await);
    assert!(d["note"].as_str().unwrap().starts_with("Không luật nào khớp"));
}
