use std::sync::Arc;

use serde_json::json;
use trinity_auth::Security;
use trinity_auth::sync::Message;
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};

use super::*;
use crate::grants::Grants;

async fn cache() -> (Arc<Security>, Arc<RbacCache>) {
    // Pool lười: không chạm DB trong các test này.
    let db = Db::connect_lazy(&DbConfig::new("postgresql://u@localhost:1/x")).unwrap();
    let sec = Security::new(db.clone(), Platform::new(&db, None), true);
    let cache = RbacCache::new(sec.clone());
    (sec, cache)
}

fn gr() -> GrantsResult {
    GrantsResult {
        grants: Grants::new(),
        is_admin: false,
    }
}

fn msg(company: i32, ids: serde_json::Value) -> Message {
    Message {
        kind: "rbac".into(),
        company,
        fields: json!({ "ids": ids }),
    }
}

#[tokio::test]
async fn vo_hieu_giua_luc_doc_thi_khong_ghi_du_lieu_cu() {
    let (_s, c) = cache().await;
    let g = c.generation();
    // Vô hiệu đến trong lúc người đọc đang chờ DB.
    c.drop_local(1, &Users::Ids(vec![7]));
    let v = c.set_grants(g, 1, 7, gr());
    assert!(!v.is_admin, "người gọi vẫn nhận giá trị vừa đọc");
    assert!(c.get_grants(1, 7).is_none(), "nhưng cache không giữ dữ liệu cũ");
    let g = c.generation();
    c.clear();
    c.set_scope(g, 1, 7, Scope::Team, vec![7]);
    assert!(c.get_scope(1, 7, Scope::Team).is_none());
    // Không có vô hiệu xen giữa: ghi bình thường.
    let g = c.generation();
    c.set_grants(g, 1, 7, gr());
    c.set_scope(g, 1, 7, Scope::Team, vec![7]);
    assert!(c.get_grants(1, 7).is_some() && c.get_scope(1, 7, Scope::Team).is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn chay_dua_nhieu_luong_khong_de_lai_cache_cu() {
    let (_s, c) = cache().await;
    for round in 0..200 {
        let g = c.generation();
        let (c1, c2) = (c.clone(), c.clone());
        let reader = tokio::spawn(async move {
            tokio::task::yield_now().await;
            c1.set_grants(g, 1, 7, gr());
        });
        let inval = tokio::spawn(async move { c2.drop_local(1, &Users::Ids(vec![7])) });
        let _ = tokio::join!(reader, inval);
        // Vô hiệu xảy ra SAU lúc chụp thế hệ ⇒ dù thứ tự thế nào, sau cả hai không được còn mục cũ.
        assert!(c.get_grants(1, 7).is_none(), "vòng {round}: còn cache cũ sau vô hiệu");
    }
}

#[tokio::test]
async fn tin_rbac_chi_xoa_cong_ty_hop_le_va_nhan_id_dang_chuoi() {
    let (_s, c) = cache().await;
    for (co, user) in [(1, 12), (1, 1), (2, 12)] {
        let g = c.generation();
        c.set_grants(g, co, user, gr());
    }
    // c = 0 / âm: bỏ tin.
    c.handle(&msg(0, json!([12])));
    c.handle(&msg(-1, json!("*")));
    assert!(c.get_grants(1, 12).is_some() && c.get_grants(2, 12).is_some());
    // id dạng chuỗi số, số thực nguyên; id rác bỏ; user 1 không xoá nhầm 12.
    c.handle(&msg(1, json!(["1", 5.0, "abc", null, 1.5])));
    assert!(c.get_grants(1, 1).is_none());
    assert!(c.get_grants(1, 12).is_some(), "tiền tố thập phân không xoá oan");
    assert!(c.get_grants(2, 12).is_some(), "công ty khác giữ nguyên");
    c.handle(&msg(1, json!("*")));
    assert!(c.get_grants(1, 12).is_none() && c.get_grants(2, 12).is_some());
    // Sai dạng `ids`: bỏ.
    c.handle(&msg(2, json!({ "x": 1 })));
    assert!(c.get_grants(2, 12).is_some());
}

#[tokio::test]
async fn closure_khong_giu_cache_song_them() {
    let (sec, c) = cache().await;
    let weak = Arc::downgrade(&c);
    drop(c);
    assert!(
        weak.upgrade().is_none(),
        "Security giữ closure nhưng không giữ RbacCache"
    );
    drop(sec);
}

#[tokio::test]
async fn ttl_het_han_thi_bo() {
    let (s, _c) = cache().await;
    let c = RbacCache::with_ttl(s, Duration::from_millis(30));
    let g = c.generation();
    c.set_grants(g, 1, 7, gr());
    assert!(c.get_grants(1, 7).is_some());
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert!(c.get_grants(1, 7).is_none());
}
