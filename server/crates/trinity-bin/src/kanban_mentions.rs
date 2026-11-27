//! Đồng bộ thẻ @ (`record_links`) của Kanban như bản Node (`kanban-cards.service.ts`, `kanban-card-activities.service.ts`):
//! mô tả thẻ (`description`) và bình luận (`comment:<id>`) ghi cạnh nguồn `task` → bản ghi được nhắc mà NGƯỜI GHI thấy được.
//! Router Kanban gọi sau khi ghi thành công, NGOÀI giao dịch ghi thẻ; lỗi chỉ ghi log (`mod_custom::refs::sync_mentions`).
//!
//! Chưa có router Kanban trên `main` (nhánh `feat/x-router-kanban`): khi nhánh đó vào, gọi
//! `sync_on_create` sau `cards::create`, `sync_on_update` sau `cards::update`, `sync_comment` sau `activities::add_comment`.

// Chưa có nơi gọi cho tới khi router Kanban được mount.
#![allow(dead_code)]

use mod_custom::refs::{Ref, RefType};
use mod_custom::{Actor, Ctx};

fn card(id: i32) -> Ref {
    Ref { ty: RefType::Task, id }
}

/// Node: `if (dto.description) sync(...)` — chỉ khi mô tả có chữ (rỗng/không gửi thì không đụng cạnh nào).
fn text_on_create(description: Option<&str>) -> Option<&str> {
    description.filter(|d| !d.is_empty())
}

/// Node: `if (dto.description !== undefined) sync(...)` — có gửi (kể cả `null`/rỗng, để xoá cạnh cũ) thì đồng bộ.
/// Ngoài: không gửi ⇒ `None` (bỏ qua); gửi ⇒ `Some(văn bản hoặc None)`.
fn text_on_update(description: Option<&Option<String>>) -> Option<Option<&str>> {
    description.map(Option::as_deref)
}

/// Sau `POST /kanban/cards`.
pub(crate) async fn sync_on_create(ctx: &Ctx, actor: &Actor, card_id: i32, description: Option<&str>) {
    if let Some(text) = text_on_create(description) {
        mod_custom::refs::sync_mentions(ctx, actor, card(card_id), "description", Some(text)).await;
    }
}

/// Sau `PATCH /kanban/cards/:id` (`description` là trường `UpdateCard::description`).
pub(crate) async fn sync_on_update(ctx: &Ctx, actor: &Actor, card_id: i32, description: Option<&Option<String>>) {
    if let Some(text) = text_on_update(description) {
        mod_custom::refs::sync_mentions(ctx, actor, card(card_id), "description", text).await;
    }
}

/// Sau `POST /kanban/cards/:id/comments`: trường nguồn là `comment:<id hoạt động>`.
pub(crate) async fn sync_comment(ctx: &Ctx, actor: &Actor, card_id: i32, activity_id: i32, content: &str) {
    let field = format!("comment:{activity_id}");
    mod_custom::refs::sync_mentions(ctx, actor, card(card_id), &field, Some(content)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tao_the_chi_dong_bo_khi_mo_ta_co_chu() {
        assert_eq!(text_on_create(None), None);
        assert_eq!(text_on_create(Some("")), None);
        assert_eq!(text_on_create(Some("gặp @hs001")), Some("gặp @hs001"));
    }

    #[test]
    fn sua_the_dong_bo_ca_khi_xoa_mo_ta() {
        assert_eq!(text_on_update(None), None);
        assert_eq!(text_on_update(Some(&None)), Some(None));
        assert_eq!(text_on_update(Some(&Some(String::new()))), Some(Some("")));
        assert_eq!(text_on_update(Some(&Some("@hs1".to_owned()))), Some(Some("@hs1")));
    }

    #[test]
    fn nguon_la_cong_viec() {
        assert_eq!(card(7).ty, RefType::Task);
        assert_eq!(card(7).id, 7);
    }
}
