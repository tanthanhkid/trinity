//! `get_setup_guide`, `list_features` (`setup-tools.ts`, `setup-guide.ts`, `feature-tools.ts`). Chỉ đọc; bảng ẩn và vai trò chỉ lộ
//! cho người có quyền tương ứng.

use mod_custom::access::{OBJ_COLS, is_object_visible, load_access};
use serde_json::{Value, json};
use trinity_db::models::CustomObject;
use trinity_integrations::status::{mcp_resource_url, public_base_url};
use trinity_rbac::can;
use trinity_rbac::plan::ORG_FEATURES;

use super::wrapped;
use crate::deps::app_err;
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

fn internal(e: sqlx::Error) -> ToolError {
    ToolError::Internal(e.to_string())
}

/// `(khoá, mô tả một dòng)` của `ORG_FEATURES`.
const DESCRIPTIONS: [(&str, &str); 19] = [
    (
        "dashboard",
        "Trang đầu: trợ lý AI đang làm gì, kênh đã kết nối, số liệu chính.",
    ),
    ("contacts", "Danh bạ khách hàng, nguồn khách, giai đoạn chăm sóc."),
    ("kanban", "Bảng công việc dạng thẻ (Kanban), giao việc và hạn chót."),
    ("reports", "Báo cáo khách hàng, nhân viên, kênh."),
    ("inbox", "Gom tin Messenger và Zalo OA vào một chỗ để trả lời khách."),
    (
        "facebook_page",
        "Nhận và trả lời tin Messenger, bình luận, lead từ Lead Ads vào khách hàng.",
    ),
    ("zalo_oa", "Nhận và trả lời tin Zalo OA, gửi thông báo ZNS."),
    (
        "social_posting",
        "Soạn một lần, đăng hoặc hẹn giờ ra một hoặc nhiều Fanpage; trợ lý AI soạn và đăng được.",
    ),
    ("products", "Danh mục sản phẩm, dịch vụ và giá."),
    ("pos", "Bán hàng tại quầy, in hoá đơn."),
    (
        "online_store",
        "Trang bán hàng online: khách đặt COD hoặc chuyển khoản QR, đơn vào thẳng CRM.",
    ),
    (
        "management",
        "Nhân viên, phòng ban, team, chức danh, hợp đồng, tuyển dụng.",
    ),
    ("attendance", "Nhân viên tự chấm công, quản lý ngày công."),
    ("payroll", "Bảng lương và phiếu lương."),
    ("newsfeed", "Bảng tin nội bộ của công ty."),
    (
        "integrations",
        "Kết nối trợ lý AI (ChatGPT, Claude, Gemini…), webhook và nhật ký tích hợp.",
    ),
    (
        "ai_briefing",
        "Bản tin số liệu sáng và chiều do trợ lý AI của bạn viết.",
    ),
    (
        "lead_scoring",
        "Chấm điểm khách theo quy tắc; trợ lý AI chấm thêm ý định mua.",
    ),
    ("stale_reminders", "Nhắc nhân viên liên hệ lại khách hoặc việc quá hạn."),
];

const GROUPS: [(&str, &str); 5] = [
    ("core", "Cơ bản"),
    ("channels", "Kênh & hộp thư"),
    ("sales", "Bán hàng"),
    ("people", "Nhân sự"),
    ("advanced", "Nâng cao"),
];

const BASIC_FEATURES: [&str; 6] = ["dashboard", "contacts", "kanban", "reports", "inbox", "integrations"];

fn interview() -> Value {
    json!([
        { "topic": "nganh", "ask": "Công ty anh/chị làm ngành gì, bán sản phẩm/dịch vụ gì, khoảng bao nhiêu người dùng CRM?", "why": "Chọn bảng chính và mẫu ngành gần nhất (list_object_templates)." },
        { "topic": "doi_tuong", "ask": "Anh/chị đang theo dõi những \"thứ\" nào: khách hàng, học viên, hồ sơ, đơn hàng, căn hộ, lịch hẹn…? Mỗi thứ cần ghi những thông tin gì?", "why": "Mỗi \"thứ\" là một bảng; thông tin là các trường." },
        { "topic": "quy_trinh", "ask": "Từ lúc có một khách mới tới lúc chốt và chăm sóc sau bán, khách đi qua những bước nào (theo thứ tự)? Bước nào hay bị kẹt?", "why": "Các bước = trường select \"Trạng thái\" theo đúng thứ tự → màn kanban." },
        { "topic": "nguoi", "ask": "Ai làm bước nào (sale, tư vấn, kế toán, quản lý)? Ai được xem dữ liệu của ai?", "why": "Trường người phụ trách (type user) và vai trò được thấy menu (set_menu.roles)." },
        { "topic": "cong_cu", "ask": "Hiện anh/chị theo dõi bằng gì: Google Sheet, Excel, sổ tay, phần mềm khác? Cần chấm công, lương, bán hàng tại quầy, Zalo… không?", "why": "Chỉ bật module có sẵn khi thật sự cần (features); còn lại để tắt cho gọn." },
        { "topic": "du_lieu", "ask": "Anh/chị gửi giúp link Google Sheet (quyền xem) hoặc file Excel đang dùng để tôi nhập dữ liệu cũ vào luôn.", "why": "Đọc file phía AI, ghép cột vào trường rồi import_records theo lô ≤500 dòng." },
    ])
}

fn steps() -> Value {
    json!([
        "1. Hỏi từng câu trong interview, MỘT câu mỗi lượt, bằng tiếng Việt dễ hiểu; tóm tắt lại và hỏi khách xác nhận.",
        "1b. Khách chỉ cần hệ thống gần với một ngành có sẵn (giáo dục, bất động sản, bán lẻ và dịch vụ, phòng khám, khác) thì gọi setup_build {industry, features?} — dựng đủ trong một lần, không cần propose_workspace.",
        "2. Có thể gọi list_object_templates để tham khảo mẫu ngành, nhưng dựng theo đúng lời khách.",
        "2b. TRA VAI TRÒ TRƯỚC: get_setup_guide.current.roles là các vai trò CÓ THẬT trong hệ thống. Chỉ dùng đúng tên đó cho menu.roles; vai trò khách nói mà chưa có (vd \"Lễ tân\") thì hỏi khách: bỏ trống (mọi người thấy) hoặc nhờ quản trị viên tạo ở Cài đặt › Vai trò rồi mới dựng.",
        "3. Gọi propose_workspace MỘT lần: objects (bảng + trường; bước quy trình = trường select có choices theo thứ tự), views (kanban group_by = trường trạng thái), menu, features (module có sẵn cần bật). Gói được dựng ngay theo quyền của khách. (Chỉ khi workspace bật \"Yêu cầu duyệt thay đổi do AI\": báo khách vào mục \"Hoạt động AI\" trong Trinity để duyệt.)",
        "4. Kiểm kết quả trả về (status=executed). Nếu lỗi: hỏi lại khách, sửa rồi gọi lại. (Chế độ duyệt: hỏi get_action_status tới khi approved.)",
        "5. Đọc Google Sheet/Excel của khách, ghép cột theo describe_schema, gọi import_records từng lô ≤500 dòng (kèm mapping + source). Bảng có liên kết (vd Khách hàng ← Đơn hàng ← Sản phẩm): gửi CẢ CÁC BẢNG trong một lần import_records với tables (cha trước), bảng con tham chiếu cha bằng khoá nghiệp vụ {\"ma_kh\": \"C001\"} hoặc mã chung — một lần ghi hết, không phải gửi lô cha rồi mới gửi lô con.",
        "5b. MÃ CHUNG: mỗi bản ghi tự có mã = tiền tố bảng + số (đơn hàng DH001, khách hàng KH001). Dùng mã khi nói chuyện với khách và để liên kết: find_by_code (tra), get_record/update_record với code, link_records (gắn liên kết), trường kiểu link, hoặc gắn thẻ @DH001 trong ô chữ dài.",
        "6. Xong thì gọi complete_setup để mở CRM cho cả công ty.",
        "Sau khi dựng: đổi cấu trúc vẫn được (update_field, archive_field, update_view…) nhưng Trinity sẽ hiện CẢNH BÁO số bản ghi bị ảnh hưởng; hãy nói rõ với khách và xin xác nhận TRƯỚC khi thực hiện.",
    ])
}

pub fn get_setup_guide<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let can_build = can(&p.grants, "custom_objects.manage", None);
        let actor = deps.custom_actor(p);
        let settings = deps.settings_ctx(p);
        let mut conn = deps.conn(p.company).await?;
        let status = mod_setup::status::get(&mut conn).await;
        let all: Vec<CustomObject> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {OBJ_COLS} FROM custom_objects WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 60"
        )))
        .fetch_all(&mut *conn)
        .await
        .map_err(internal)?;
        let views: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM custom_views WHERE deleted_at IS NULL")
            .fetch_one(&mut *conn)
            .await
            .map_err(internal)?;
        let features = mod_settings::features::get(&mut conn, settings)
            .await
            .map_err(app_err)?;
        // Tên vai trò chỉ phục vụ menu.roles của propose_workspace/set_menu: người không dựng được cấu trúc không cần.
        let roles: Vec<String> = if can_build {
            sqlx::query_scalar("SELECT name FROM roles ORDER BY id ASC LIMIT 50")
                .fetch_all(&mut *conn)
                .await
                .map_err(internal)?
        } else {
            Vec::new()
        };
        let access = load_access(&mut conn, &actor).await.map_err(app_err)?;
        // Cùng bộ lọc với describe_schema: bảng ẩn hoặc người không có custom_records.view thì không lộ tên/khoá/mã.
        let objects: Vec<&CustomObject> = if can(&p.grants, "custom_records.view", None) || can_build {
            all.iter().filter(|o| is_object_visible(o, &access)).collect()
        } else {
            Vec::new()
        };
        let on: Vec<&str> = ORG_FEATURES
            .iter()
            .filter(|(k, _, _)| features.0.iter().any(|(fk, v)| fk == k && *v == Some(true)))
            .map(|(_, label, _)| *label)
            .collect();
        let next = match status {
            "chua_dung" => "Phỏng vấn khách rồi propose_workspace.",
            "dang_dung" => "Nhập dữ liệu (import_records) rồi complete_setup.",
            _ => "Hệ thống đang dùng — chỉ đổi cấu trúc khi khách yêu cầu rõ.",
        };
        let tables: Vec<String> = objects
            .iter()
            .map(|o| {
                let code = o.code_prefix.as_deref().filter(|c| !c.is_empty());
                format!(
                    "{} [{}]{}",
                    o.label_plural,
                    o.key,
                    code.map_or(String::new(), |c| format!(" mã {c}001…"))
                )
            })
            .collect();
        let modules: serde_json::Map<String, Value> = ORG_FEATURES
            .iter()
            .map(|(k, label, _)| ((*k).to_owned(), json!(label)))
            .collect();
        let mut out = crate::ai_output::wrap_data(&json!({
            "status": status, "can_build": can_build, "next": next, "interview": interview(), "steps": steps(),
            "current": {
                "tables": tables, "views": views, "modules_on": on, "roles": roles,
                "core_codes": { "contacts": "KH001…", "deals": "DL001…", "tasks": "CV001…" },
            },
            "modules": modules,
        }));
        // Prompt nối do chính máy chủ sinh (không chứa dữ liệu người dùng) ⇒ gắn sau wrap_data để không bị cắt 500 ký tự.
        let env = |k: &str| std::env::var(k).ok();
        let agent = args
            .get("agent")
            .and_then(Value::as_str)
            .filter(|a| mod_setup::connect::is_agent(a));
        if let (Some(agent), Some(base)) = (agent, public_base_url(&env))
            && let Some(prompt) = mod_setup::connect::build_prompt(agent, &mcp_resource_url(&base))
            && let Some(data) = out.get_mut("data").and_then(Value::as_object_mut)
        {
            data.insert("connect_prompt".into(), json!(prompt));
        }
        super::done(out)
    })
}

pub fn list_features<'a>(_args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let settings = deps.settings_ctx(p);
        let mut conn = deps.conn(p.company).await?;
        let f = mod_settings::features::get(&mut conn, settings)
            .await
            .map_err(app_err)?;
        let groups: Vec<Value> = GROUPS
            .iter()
            .map(|(gk, gl)| {
                let features: Vec<Value> = ORG_FEATURES
                    .iter()
                    .filter(|(_, _, g)| g == gk)
                    .map(|(k, label, _)| {
                        let description = DESCRIPTIONS.iter().find(|(dk, _)| dk == k).map_or("", |(_, d)| *d);
                        let enabled = !f.0.iter().any(|(fk, v)| fk == k && *v == Some(false));
                        json!({ "key": k, "label": label, "description": description, "enabled": enabled })
                    })
                    .collect();
                json!({ "group": gk, "label": gl, "features": features })
            })
            .collect();
        wrapped(&json!({ "basic": BASIC_FEATURES, "groups": groups }))
    })
}
