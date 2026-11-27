//! Tool đọc nhóm 1 (M40): `search`, `fetch`, `list_contacts`, `get_contact`, `list_contact_activities`, `list_deals`,
//! `get_dashboard_overview`, `list_my_tasks`, `list_crm_options`. Tên, mô tả và schema nằm ở hợp đồng đóng băng; ở đây chỉ có
//! scope, quyền và thân chạy. Mọi dữ liệu trả về đi qua [`crate::ai_output::wrap_data`] (SĐT luôn che) và dùng chính module nghiệp vụ
//! (cùng phạm vi quyền với giao diện web) với `Principal` đã gỡ `*.phone_full`.
//!
//! Chưa có: `get_report` (báo cáo tuỳ chỉnh `CustomReportsService` chưa chuyển sang Rust; sẽ nằm ở issue của báo cáo tuỳ chỉnh).

pub(crate) mod act_contacts;
pub(crate) mod act_records;
pub(crate) mod act_tasks;
mod contacts;
mod deals;
mod fanpage;
mod options;
mod records;
mod schema;
mod search;
mod setup;
mod social;

pub use social::{SocialDeps, register_social};

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::Value;
use trinity_kernel::json::js_json;
use trinity_rbac::can;

use crate::actions::{self, ActionTool};
use crate::ai_output::wrap_data;
use crate::auth::Principal;
use crate::deps::app_err;
use crate::exec::{ToolCtx, ToolError, ToolOutput, ToolRegistry, ToolRunner, ToolSpec};
use crate::protocol::BoxFuture;

pub use fanpage::{
    BroadcastsPort, ChatLinksPort, CommentQuery, CommentsPort, FanpagePorts, FlowsPort, PageRef, PagesPort,
    ScheduledPostsPort, register_fanpage,
};

type RunFn = for<'a> fn(&'a Value, &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>>;

struct Tool(RunFn);

impl ToolRunner for Tool {
    fn run<'a>(&'a self, args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        (self.0)(args, ctx)
    }
}

/// Kết quả có cả `structured` và văn bản JSON của nó.
pub(crate) fn done(structured: Value) -> Result<ToolOutput, ToolError> {
    Ok(ToolOutput {
        text: Some(js_json(&structured)),
        structured,
    })
}

/// `{ notice, data }` với `data` đã che SĐT/bỏ khoá nhạy cảm.
pub(crate) fn wrapped(data: &Value) -> Result<ToolOutput, ToolError> {
    done(wrap_data(data))
}

pub(crate) fn forbidden(msg: &str) -> ToolError {
    ToolError::Forbidden(msg.to_owned())
}

/// Khách trong danh `ids` mà người gọi XEM ĐƯỢC (cùng bộ lọc phạm vi `contacts.view` với `list_contacts`/`search`/`get_contact`),
/// một truy vấn cho cả trang. Deal/thẻ không lộ cái mà khách đã từ chối (id, tên, SĐT).
pub(crate) async fn visible_contacts(
    scopes: &mod_contacts::Scopes,
    p: &Principal,
    conn: &mut trinity_db::TenantConn,
    ids: &[Option<i32>],
) -> Result<HashSet<i32>, ToolError> {
    let want: Vec<i32> = ids
        .iter()
        .flatten()
        .copied()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if !can(&p.grants, "contacts.view", None) || want.is_empty() {
        return Ok(HashSet::new());
    }
    let wh = mod_contacts::filter::resolve(conn, scopes, &mod_contacts::filter::ContactFilters::default())
        .await
        .map_err(app_err)?;
    let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new("SELECT c.id FROM contacts c WHERE ");
    wh.push_aliased(&mut qb);
    qb.push(" AND c.id = ANY(").push_bind(want).push(")");
    let rows: Vec<(i32,)> = qb
        .build_query_as()
        .fetch_all(&mut **conn)
        .await
        .map_err(|e| ToolError::Internal(e.to_string()))?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

fn reg(r: &mut ToolRegistry, name: &'static str, permissions: &'static [&'static str], run: RunFn) {
    r.register(ToolSpec {
        name,
        scope: None,
        permissions,
        runner: Arc::new(Tool(run)),
    });
}

/// Đăng ký khung thao tác ghi (M42): 8 tool ghi (`create_contact`, `add_contact_note`, `update_contact_stage`, `assign_contact`,
/// `create_task`, `create_record`, `update_record`, `archive_record`; cần scope `crm.write`) và `get_action_status`. KHÔNG có tool xoá.
pub fn register_group3(r: &mut ToolRegistry) {
    for def in actions::all() {
        r.register(ToolSpec {
            name: def.name,
            scope: Some("crm.write"),
            permissions: def.permissions,
            runner: Arc::new(ActionTool(def)),
        });
    }
    reg(r, "get_action_status", &[], actions::get_action_status);
}

/// Đăng ký 9 tool đọc của nhóm 2 (M41) vào `r`: `get_setup_guide`, `describe_schema`, `list_records`, `get_record`,
/// `find_by_code`, `list_object_templates`, `list_screen_types`, `list_structure_versions`, `list_features`.
pub fn register_group2(r: &mut ToolRegistry) {
    reg(r, "get_setup_guide", &[], setup::get_setup_guide);
    reg(r, "describe_schema", &[], schema::describe_schema);
    reg(r, "list_records", &[], records::list_records);
    reg(r, "get_record", &[], records::get_record);
    reg(r, "find_by_code", &[], records::find_by_code);
    reg(
        r,
        "list_object_templates",
        &["custom_objects.manage"],
        schema::list_object_templates,
    );
    reg(r, "list_screen_types", &[], schema::list_screen_types);
    reg(
        r,
        "list_structure_versions",
        &["custom_objects.manage"],
        schema::list_structure_versions,
    );
    reg(r, "list_features", &[], setup::list_features);
}

/// Đăng ký 9 tool của nhóm 1 vào `r`.
pub fn register_group1(r: &mut ToolRegistry) {
    reg(r, "search", &[], search::search);
    reg(r, "fetch", &[], search::fetch);
    reg(r, "list_contacts", &["contacts.view"], contacts::list_contacts);
    reg(r, "get_contact", &["contacts.view"], contacts::get_contact);
    reg(
        r,
        "list_contact_activities",
        &["contacts.view"],
        contacts::list_contact_activities,
    );
    reg(r, "list_deals", &["deals.view"], deals::list_deals);
    reg(
        r,
        "get_dashboard_overview",
        &["reports.overview"],
        deals::dashboard_overview,
    );
    reg(r, "list_my_tasks", &["kanban.view"], deals::my_tasks);
    reg(r, "list_crm_options", &[], options::list_crm_options);
}
