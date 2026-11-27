//! Bảng route của M16 (K14): 17 route thẻ, checklist và đính kèm; mỗi route khai `Access` bắt buộc, so với
//! `contracts/routes.json` ở test cuối file và ở `trinity check-routes`.

use http::Method;
use trinity_http::router::{Access, RouteSpec};

const ID: &[&str] = &["param.id:ParseIntPipe"];
const CARD_ID: &[&str] = &["param.cardId:ParseIntPipe"];

/// 17 route của `KanbanCardsController`, `KanbanChecklistController` và `KanbanAttachmentsController`.
pub fn routes() -> Vec<RouteSpec> {
    let view = Access::Can(&["kanban.view"]);
    let manage = Access::Can(&["kanban.manage"]);
    vec![
        RouteSpec::new(Method::GET, "/api/v1/kanban/cards", view).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/kanban/cards", manage).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/kanban/cards/:id", view)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::PATCH, "/api/v1/kanban/cards/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/kanban/cards/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/cards/:id/move", manage)
            .status_ok(201)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/cards/:id/restore", manage)
            .status_ok(201)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/kanban/cards/:id/activities", view)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/cards/:id/comments", manage)
            .status_ok(201)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/kanban/cards/:cardId/checklist-items", view)
            .status_ok(200)
            .param_pipes(CARD_ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/cards/:cardId/checklist-items", manage)
            .status_ok(201)
            .param_pipes(CARD_ID),
        RouteSpec::new(
            Method::POST,
            "/api/v1/kanban/cards/:cardId/checklist-items/reorder",
            manage,
        )
        .status_ok(201)
        .param_pipes(CARD_ID),
        RouteSpec::new(Method::PATCH, "/api/v1/kanban/checklist-items/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/kanban/checklist-items/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::GET, "/api/v1/kanban/cards/:cardId/attachments", view)
            .status_ok(200)
            .param_pipes(CARD_ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/cards/:cardId/attachments", manage)
            .status_ok(201)
            .param_pipes(CARD_ID),
        RouteSpec::new(Method::DELETE, "/api/v1/kanban/attachments/:id", manage)
            .status_ok(200)
            .param_pipes(ID),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = routes();
        assert_eq!(table.len(), 17);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 17);
    }
}
