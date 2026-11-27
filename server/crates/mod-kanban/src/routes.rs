//! Bảng route của M15 (18 route bảng, cột, nhãn, trường tuỳ biến: [`board_routes`]) và M16 (17 route thẻ, checklist và đính
//! kèm: [`routes`]) (K14); mỗi route khai `Access` bắt buộc, so với `contracts/routes.json` ở test cuối file và ở
//! `trinity check-routes`.

use http::Method;
use trinity_http::router::{Access, RouteSpec};

const ID: &[&str] = &["param.id:ParseIntPipe"];
const CARD_ID: &[&str] = &["param.cardId:ParseIntPipe"];
const BOARD_ID: &[&str] = &["param.boardId:ParseIntPipe"];

/// 18 route của `KanbanBoardsController`, `KanbanColumnsController` và `KanbanFieldDefsController`.
pub fn board_routes() -> Vec<RouteSpec> {
    let view = Access::Can(&["kanban.view"]);
    let boards = Access::Can(&["kanban.boards"]);
    vec![
        RouteSpec::new(Method::GET, "/api/v1/kanban/boards", view).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/kanban/boards", boards).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/kanban/boards/templates", boards).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/kanban/boards/from-template", boards).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/kanban/boards/:id", view)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::PATCH, "/api/v1/kanban/boards/:id", boards)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/kanban/boards/:id", boards)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/boards/:id/labels", view)
            .status_ok(201)
            .param_pipes(ID),
        RouteSpec::new(Method::PATCH, "/api/v1/kanban/boards/:id/labels/:labelId", view)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/kanban/boards/:id/labels/:labelId", view)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/boards/:boardId/columns", boards)
            .status_ok(201)
            .param_pipes(BOARD_ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/boards/:boardId/columns/reorder", boards)
            .status_ok(201)
            .param_pipes(BOARD_ID),
        RouteSpec::new(Method::PATCH, "/api/v1/kanban/columns/:id", boards)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/kanban/columns/:id", boards)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/boards/:boardId/field-defs", boards)
            .status_ok(201)
            .param_pipes(BOARD_ID),
        RouteSpec::new(Method::POST, "/api/v1/kanban/boards/:boardId/field-defs/reorder", boards)
            .status_ok(201)
            .param_pipes(BOARD_ID),
        RouteSpec::new(Method::PATCH, "/api/v1/kanban/field-defs/:id", boards)
            .status_ok(200)
            .param_pipes(ID),
        RouteSpec::new(Method::DELETE, "/api/v1/kanban/field-defs/:id", boards)
            .status_ok(200)
            .param_pipes(ID),
    ]
}

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

    #[test]
    fn khop_hop_dong_routes_json_bang_cot_nhan_truong() {
        let table = board_routes();
        assert_eq!(table.len(), 18);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 18);
    }
}
