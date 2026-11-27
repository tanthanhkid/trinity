//! Logic của 5 endpoint công khai (`public-api.service.ts`, `public-work.service.ts`).

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use sqlx::{PgConnection, Row};
use trinity_db::outbox::publish_integration_event;
use trinity_db::types::Timestamp;
use trinity_kernel::error::{AppError, HttpError, Message};
use trinity_kernel::phone::{normalize_phone, phone_variants};
use trinity_kernel::vn_time::js_iso_string;
use trinity_rbac::{Grants, OwnerIds, can};

use crate::PublicCtx;
use crate::guards::KeyInfo;

type R<T> = Result<T, AppError>;

fn db(e: sqlx::Error) -> AppError {
    trinity_db::pg_error::app_error(&e)
}

fn bad(msg: impl Into<Message>) -> AppError {
    HttpError::bad_request(msg).into()
}

fn forbidden(msg: &str) -> AppError {
    HttpError::forbidden(msg).into()
}

fn iso(t: DateTime<Utc>) -> Value {
    json!(js_iso_string(t))
}

// ---------------------------------------------------------------- khách

/// Nguồn khách phải thuộc nhóm `contact_source` và đang bật.
async fn validate_source(conn: &mut PgConnection, id: i64) -> R<()> {
    let row: Option<(String, bool)> = sqlx::query_as("SELECT group_key, is_active FROM setting_options WHERE id = $1")
        .bind(i32::try_from(id).unwrap_or(0))
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    match row {
        Some((g, a)) if g == "contact_source" => {
            if a {
                Ok(())
            } else {
                Err(bad(format!("Nguồn khách ID {id} đang bị tắt")))
            }
        }
        _ => Err(bad(format!("source_id {id} không thuộc group contact_source"))),
    }
}

pub struct Owner {
    pub id: i32,
    pub team_id: Option<i32>,
}

async fn load_owner(conn: &mut PgConnection, id: i32) -> R<Owner> {
    let row: Option<(String, Option<i32>)> = sqlx::query_as("SELECT status, team_id FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    match row {
        Some((s, team_id)) if s == "active" => Ok(Owner { id, team_id }),
        _ => Err(bad(format!(
            "Owner user ID {id} của khoá API không còn hoạt động. Liên hệ quản trị viên."
        ))),
    }
}

pub struct NewContact<'a> {
    pub phone: &'a str,
    /// Cột `full_name` cho phép NULL (webhook Zalo không phải lúc nào cũng có tên).
    pub full_name: Option<&'a str>,
    pub source_id: Option<i32>,
    pub email: Option<&'a str>,
    pub job_title: Option<&'a str>,
    pub reminder_notes: Option<&'a str>,
    /// Id Zalo của khách (webhook Zalo OA tạo khách mới).
    pub zalo_account: Option<&'a str>,
}

/// LÕI tạo khách của bên thứ ba (`createContactInTx`): gán `assigned_to = owner`, kế thừa `team_id` của owner, ghi outbox
/// `contact.created` (origin = kênh) trong CHÍNH giao dịch của người gọi. Trả `(id, phone, full_name, source_id, assigned_to, created_at)`.
pub async fn create_contact_in_tx(
    conn: &mut PgConnection,
    c: &NewContact<'_>,
    owner: &Owner,
    origin: &str,
) -> R<(i32, DateTime<Utc>)> {
    let (id, created): (i32, Timestamp) = sqlx::query_as(
        "INSERT INTO contacts (phone, full_name, source_id, email, job_title, reminder_notes, zalo_account, assigned_to, team_id, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $9, $7, $8, now()) RETURNING id, created_at",
    )
    .bind(c.phone)
    .bind(c.full_name)
    .bind(c.source_id)
    .bind(c.email)
    .bind(c.job_title)
    .bind(c.reminder_notes)
    .bind(owner.id)
    .bind(owner.team_id)
    .bind(c.zalo_account)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    let snap = mod_contacts::snapshot::contact_event(conn, id).await?.snapshot();
    publish_integration_event(
        conn,
        "contact.created",
        &json!({ "contact": snap, "origin": origin }),
        id,
        None,
    )
    .await
    .map_err(AppError::internal)?;
    Ok((id, created.0))
}

/// `POST /public/contacts`. `dto` đã qua `PublicCreateContactDto`.
pub async fn create_contact(ctx: &PublicCtx, key: &KeyInfo, dto: &Map<String, Value>) -> R<Value> {
    let tenant = ctx.db.tenant(key.company).await.map_err(AppError::internal)?;
    let mut conn = tenant.acquire().await.map_err(AppError::internal)?;
    let source_id = dto.get("source_id").and_then(Value::as_i64).unwrap_or(0);
    validate_source(&mut conn, source_id).await?;
    let owner = load_owner(&mut conn, key.owner_user_id).await?;
    let raw_phone = dto.get("phone").and_then(Value::as_str).unwrap_or("");
    // DTO nhận cả `0…` lẫn `+84…`: chuẩn hoá về 0xxxxxxxxx để kiểm trùng không bị lọt.
    let phone = normalize_phone(raw_phone).unwrap_or_else(|| raw_phone.to_owned());
    // Chỉ kiểm trùng trong phạm vi cùng owner: không lộ "SĐT đã tồn tại" cho khách của owner khác.
    let dup: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM contacts WHERE phone = ANY($1) AND deleted_at IS NULL AND assigned_to = $2 LIMIT 1",
    )
    .bind(phone_variants(&phone))
    .bind(owner.id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    drop(conn);
    // Khách + outbox `contact.created` CÙNG giao dịch.
    let mut tx = ctx
        .db
        .tenant(key.company)
        .await
        .map_err(AppError::internal)?
        .begin()
        .await
        .map_err(AppError::internal)?;
    let s = |k: &str| dto.get(k).and_then(Value::as_str).map(str::to_owned);
    let full_name = s("full_name").unwrap_or_default();
    let (email, job, notes) = (s("email"), s("job_title"), s("reminder_notes"));
    let (id, created) = create_contact_in_tx(
        &mut tx,
        &NewContact {
            phone: &phone,
            full_name: Some(&full_name),
            source_id: i32::try_from(source_id).ok(),
            email: email.as_deref(),
            job_title: job.as_deref(),
            reminder_notes: notes.as_deref(),
            zalo_account: None,
        },
        &owner,
        "public_api",
    )
    .await?;
    tx.commit().await.map_err(AppError::internal)?;
    tracing::info!(
        "PublicApi contact created id={id} api_key={} owner={} had_duplicate={}",
        key.id,
        owner.id,
        dup.is_some()
    );
    Ok(json!({
        "contact": {
            "id": id, "phone": phone, "full_name": full_name, "source_id": source_id,
            "assigned_to": owner.id, "created_at": iso(created),
        },
        "warning": if dup.is_some() { json!("SĐT đã tồn tại trong hệ thống — vẫn tạo thành công") } else { Value::Null },
    }))
}

/// `GET /public/contacts/sources`.
pub async fn list_sources(ctx: &PublicCtx, key: &KeyInfo) -> R<Value> {
    let mut c = ctx
        .db
        .tenant(key.company)
        .await
        .map_err(AppError::internal)?
        .acquire()
        .await
        .map_err(AppError::internal)?;
    let rows: Vec<(i32, String)> = sqlx::query_as(
        "SELECT id, label FROM setting_options WHERE group_key = 'contact_source' AND is_active \
         ORDER BY sort_order ASC, id ASC",
    )
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    Ok(json!({ "data": rows.into_iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>() }))
}

// ---------------------------------------------------------------- việc chạy dưới danh nghĩa chủ khoá

/// Chủ khoá dưới dạng người dùng (quyền tính lại mỗi lần: đổi vai trò có hiệu lực ngay).
pub struct Actor {
    pub user_id: i32,
    pub email: String,
    pub grants: Grants,
    pub company: trinity_db::CompanyRef,
}

pub async fn actor(ctx: &PublicCtx, key: &KeyInfo) -> R<Actor> {
    let mut c = ctx
        .db
        .tenant(key.company)
        .await
        .map_err(AppError::internal)?
        .acquire()
        .await
        .map_err(AppError::internal)?;
    let u: Option<(String, String)> = sqlx::query_as("SELECT email, status FROM users WHERE id = $1")
        .bind(key.owner_user_id)
        .fetch_optional(&mut *c)
        .await
        .map_err(db)?;
    drop(c);
    let Some((email, status)) = u.filter(|(_, s)| s == "active") else {
        return Err(bad("Người giữ khoá API không còn hoạt động. Liên hệ quản trị viên."));
    };
    let _ = status;
    let g = ctx
        .perms
        .grants_for(key.company, key.owner_user_id)
        .await
        .map_err(AppError::internal)?;
    // Khoá không được cấp cho Quản trị (Auth chặn lúc tạo); chủ khoá được nâng lên Quản trị SAU đó thì chặn luôn.
    if g.is_admin {
        return Err(forbidden(
            "Chủ khoá API hiện là Quản trị — khoá bị chặn. Tạo khoá mới với tài khoản nhân viên có đúng quyền cần dùng.",
        ));
    }
    Ok(Actor {
        user_id: key.owner_user_id,
        email,
        grants: g.grants.clone(),
        company: key.company,
    })
}

fn need(a: &Actor, permission: &str, label: &str) -> R<()> {
    if can(&a.grants, permission, None) {
        Ok(())
    } else {
        Err(forbidden(&format!("Người giữ khoá không có quyền {label}.")))
    }
}

async fn owners(ctx: &PublicCtx, a: &Actor, permission: &str) -> R<Option<OwnerIds>> {
    ctx.scopes
        .owner_ids(a.company, a.user_id, &a.grants, permission)
        .await
        .map_err(AppError::internal)
}

/// Khách gắn kèm: tìm theo SĐT trong phạm vi `contacts.view` của chủ khoá; không thấy thì tạo mới khi có `contact_name`
/// (cần quyền `contacts.create`). Không gửi SĐT ⇒ không gắn khách. Trả `(id, đã_tạo_mới)`.
pub async fn resolve_contact(ctx: &PublicCtx, a: &Actor, dto: &Map<String, Value>) -> R<Option<(i32, bool)>> {
    let Some(raw) = dto
        .get("contact_phone")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
    else {
        return Ok(None);
    };
    let phone = normalize_phone(raw).unwrap_or_else(|| raw.to_owned());
    let view = owners(ctx, a, "contacts.view").await?;
    let mut c = ctx
        .db
        .tenant(a.company)
        .await
        .map_err(AppError::internal)?
        .acquire()
        .await
        .map_err(AppError::internal)?;
    if let Some(view) = &view {
        let ids: Vec<i32> = match view {
            OwnerIds::All => Vec::new(),
            OwnerIds::Ids(v) => v.clone(),
        };
        let found: Option<i32> = sqlx::query_scalar(
            "SELECT id FROM contacts WHERE phone = ANY($1) AND deleted_at IS NULL \
             AND ($2 OR assigned_to = ANY($3) OR created_by_id = ANY($3)) ORDER BY id ASC LIMIT 1",
        )
        .bind(phone_variants(&phone))
        .bind(matches!(view, OwnerIds::All))
        .bind(&ids)
        .fetch_optional(&mut *c)
        .await
        .map_err(db)?;
        if let Some(id) = found {
            return Ok(Some((id, false)));
        }
    }
    let name = dto
        .get("contact_name")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    let Some(name) = name else {
        return Err(bad(
            "Không tìm thấy khách có SĐT này. Gửi thêm contact_name để tạo khách mới.",
        ));
    };
    need(a, "contacts.create", "tạo khách hàng")?;
    // Khách mới gắn vào thương vụ/việc phải nằm trong phạm vi `contacts.view` của chủ khoá: kiểm TRƯỚC khi tạo để không để lại
    // khách mồ côi khi bước sau từ chối.
    trinity_rbac::assert_in_scope(view.as_ref(), &[Some(a.user_id), None]).map_err(|e| AppError::Http(*e))?;
    let source = dto.get("contact_source_id").and_then(Value::as_i64);
    if let Some(sid) = source {
        let opt: Option<(String, bool)> =
            sqlx::query_as("SELECT group_key, is_active FROM setting_options WHERE id = $1")
                .bind(i32::try_from(sid).unwrap_or(0))
                .fetch_optional(&mut *c)
                .await
                .map_err(db)?;
        if !opt.is_some_and(|(g, act)| g == "contact_source" && act) {
            return Err(bad(format!("contact_source_id {sid} không phải nguồn khách đang bật")));
        }
    }
    let team: Option<i32> = sqlx::query_scalar("SELECT team_id FROM users WHERE id = $1")
        .bind(a.user_id)
        .fetch_one(&mut *c)
        .await
        .map_err(db)?;
    drop(c);
    let mut tx = ctx
        .db
        .tenant(a.company)
        .await
        .map_err(AppError::internal)?
        .begin()
        .await
        .map_err(AppError::internal)?;
    let (id, _) = create_contact_in_tx(
        &mut tx,
        &NewContact {
            phone: &phone,
            full_name: Some(&name),
            source_id: source.and_then(|s| i32::try_from(s).ok()),
            email: None,
            job_title: None,
            reminder_notes: None,
            zalo_account: None,
        },
        &Owner {
            id: a.user_id,
            team_id: team,
        },
        "public_api",
    )
    .await?;
    tx.commit().await.map_err(AppError::internal)?;
    Ok(Some((id, true)))
}

// ---------------------------------------------------------------- thương vụ

/// Tạo thương vụ qua `mod_deals::deals::create` (cùng luật với `POST /deals`: phạm vi `deals.manage`, `contacts.view`, outbox,
/// thông báo "được giao thương vụ", SĐT khách che theo `contacts.phone_full`), gán cho chính chủ khoá.
async fn insert_deal(
    ctx: &PublicCtx,
    a: &Actor,
    scopes: &mod_deals::Scopes,
    dto: &Map<String, Value>,
    contact_id: Option<i32>,
) -> R<Value> {
    let tenant = ctx.db.tenant(a.company).await.map_err(AppError::internal)?;
    let input = mod_deals::deals::CreateDeal {
        title: dto.get("title").and_then(Value::as_str).unwrap_or("").to_owned(),
        description: dto.get("description").and_then(Value::as_str).map(str::to_owned),
        value: dto.get("value").and_then(Value::as_i64),
        status: dto.get("status").and_then(Value::as_str).map(str::to_owned),
        note: dto.get("note").and_then(Value::as_str).map(str::to_owned),
        assigned_to: a.user_id,
        contact_id,
    };
    let actor = mod_deals::Actor {
        user_id: a.user_id,
        is_admin: false,
        email: Some(a.email.clone()),
    };
    let created = mod_deals::deals::create(&tenant, scopes, &actor, &input).await?;
    let text = serde_json::to_string(&created.deal).map_err(AppError::internal)?;
    serde_json::from_str(&text).map_err(AppError::internal)
}

/// `POST /public/deals`. `dto` đã qua `PublicCreateDealDto`.
pub async fn create_deal(ctx: &PublicCtx, key: &KeyInfo, dto: &Map<String, Value>) -> R<Value> {
    let a = actor(ctx, key).await?;
    need(&a, "deals.manage", "tạo thương vụ")?;
    // Mọi kiểm phạm vi TRƯỚC khi có thể tạo khách mới: bị từ chối ở bước thương vụ thì không để lại khách mồ côi.
    let scopes = mod_deals::Scopes::resolve(&ctx.scopes, a.company, a.user_id, &a.grants).await?;
    let manage_ok = match &scopes.deals_manage {
        Some(OwnerIds::All) => true,
        Some(OwnerIds::Ids(ids)) => ids.contains(&a.user_id),
        None => false,
    };
    if !manage_ok {
        return Err(forbidden("Không có quyền tạo thương vụ cho người này"));
    }
    let contact = resolve_contact(ctx, &a, dto).await?;
    let deal = insert_deal(ctx, &a, &scopes, dto, contact.map(|c| c.0)).await?;
    tracing::info!(
        "PublicApi deal created api_key={} owner={} contact_created={}",
        key.id,
        a.user_id,
        contact.is_some_and(|c| c.1)
    );
    Ok(json!({
        "deal": deal,
        "contact_id": contact.map(|c| c.0),
        "contact_created": contact.is_some_and(|c| c.1),
    }))
}

// ---------------------------------------------------------------- việc (thẻ Kanban)

async fn kanban_actor(ctx: &PublicCtx, a: &Actor) -> R<mod_kanban::Actor> {
    let role_ids: Vec<i32> = {
        let mut c = ctx
            .db
            .tenant(a.company)
            .await
            .map_err(AppError::internal)?
            .acquire()
            .await
            .map_err(AppError::internal)?;
        sqlx::query_scalar("SELECT role_id FROM user_roles WHERE user_id = $1")
            .bind(a.user_id)
            .fetch_all(&mut *c)
            .await
            .map_err(db)?
    };
    Ok(mod_kanban::Actor {
        user_id: a.user_id,
        is_admin: false,
        access: mod_kanban::Access {
            can_manage_boards: can(&a.grants, "kanban.boards", None),
            role_ids,
        },
        card_owner: owners(ctx, a, "kanban.view").await?,
        can_view_contacts: can(&a.grants, "contacts.view", None),
        contact_view: owners(ctx, a, "contacts.view").await?,
        contact_phone_full: owners(ctx, a, "contacts.phone_full").await?,
    })
}

/// `POST /public/tasks`. `dto` đã qua `PublicCreateTaskDto`.
pub async fn create_task(ctx: &PublicCtx, key: &KeyInfo, dto: &Map<String, Value>) -> R<Value> {
    let a = actor(ctx, key).await?;
    need(&a, "kanban.manage", "tạo việc trên bảng Kanban")?;
    let ka = kanban_actor(ctx, &a).await?;
    let tenant = ctx.db.tenant(a.company).await.map_err(AppError::internal)?;
    let mut c = tenant.acquire().await.map_err(AppError::internal)?;
    // Kiểm cột/bảng/trường bắt buộc TRƯỚC khi có thể tạo khách mới: lỗi ở đây không để lại khách thừa.
    let column_id = dto
        .get("column_id")
        .and_then(Value::as_i64)
        .and_then(|v| i32::try_from(v).ok());
    let col: Option<(i32, bool)> = match column_id {
        Some(id) => sqlx::query_as("SELECT board_id, is_archived FROM kanban_columns WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *c)
            .await
            .map_err(db)?,
        None => None,
    };
    let Some((board_id, archived)) = col else {
        return Err(bad("column_id không hợp lệ"));
    };
    mod_kanban::boards::load_visible(&mut c, &ka.access, board_id).await?;
    if archived {
        return Err(bad("Cột đã ẩn — không thể tạo việc vào đây"));
    }
    let defs = sqlx::query_as::<_, trinity_db::models::KanbanFieldDef>(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM kanban_field_defs WHERE board_id = $1 ORDER BY position ASC, id ASC",
        "id, board_id, key, label, type, options, required, show_on_card, position, created_at, updated_at"
    )))
    .bind(board_id)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    mod_kanban::attributes::validate(&defs, Some(dto.get("attributes").unwrap_or(&json!({}))), false)?;
    drop(c);
    let contact = resolve_contact(ctx, &a, dto).await?;
    let s = |k: &str| dto.get(k).and_then(Value::as_str).map(str::to_owned);
    let input = mod_kanban::cards::CreateCard {
        column_id: column_id.unwrap_or(0),
        title: s("title").unwrap_or_default(),
        description: s("description"),
        contact_id: contact.map(|c| c.0),
        assignee_id: Some(a.user_id),
        assignee_ids: None,
        due_at: s("due_at"),
        priority: s("priority"),
        labels: dto
            .get("labels")
            .and_then(Value::as_array)
            .map(|l| l.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()),
        attributes: dto.get("attributes").cloned(),
    };
    let mut c = tenant.acquire().await.map_err(AppError::internal)?;
    let card = mod_kanban::cards::create(&mut c, &ka, &input).await?;
    tracing::info!("PublicApi task created api_key={} owner={}", key.id, a.user_id);
    Ok(json!({
        "task": card,
        "contact_id": contact.map(|c| c.0),
        "contact_created": contact.is_some_and(|c| c.1),
    }))
}

/// `GET /public/tasks/columns`: bảng và cột Kanban chủ khoá được thấy (để điền `column_id`).
pub async fn columns(ctx: &PublicCtx, key: &KeyInfo) -> R<Value> {
    let a = actor(ctx, key).await?;
    need(&a, "kanban.view", "xem bảng Kanban")?;
    let ka = kanban_actor(ctx, &a).await?;
    let mut c = ctx
        .db
        .tenant(a.company)
        .await
        .map_err(AppError::internal)?
        .acquire()
        .await
        .map_err(AppError::internal)?;
    let boards: Vec<(i32, String)> = sqlx::query_as(
        "SELECT id, name FROM kanban_boards WHERE deleted_at IS NULL \
         AND ($1 OR (is_active AND (cardinality(visibility_role_ids) = 0 OR visibility_role_ids && $2))) ORDER BY id ASC",
    )
    .bind(ka.access.can_manage_boards)
    .bind(&ka.access.role_ids)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let ids: Vec<i32> = boards.iter().map(|b| b.0).collect();
    let cols: Vec<(i32, i32, String)> = sqlx::query_as(
        "SELECT board_id, id, name FROM kanban_columns WHERE board_id = ANY($1) AND NOT is_archived \
         ORDER BY position ASC, id ASC",
    )
    .bind(&ids)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let defs = sqlx::query(
        "SELECT board_id, key, label, type, options, required FROM kanban_field_defs WHERE board_id = ANY($1) \
         ORDER BY position ASC, id ASC",
    )
    .bind(&ids)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let data: Vec<Value> = boards
        .into_iter()
        .map(|(id, name)| {
            let columns: Vec<Value> = cols
                .iter()
                .filter(|c| c.0 == id)
                .map(|c| json!({ "column_id": c.1, "name": c.2 }))
                .collect();
            let fields: Vec<Value> = defs
                .iter()
                .filter(|r| r.get::<i32, _>("board_id") == id)
                .map(|r| {
                    json!({
                        "key": r.get::<String, _>("key"),
                        "label": r.get::<String, _>("label"),
                        "type": r.get::<String, _>("type"),
                        "options": r.get::<Option<Value>, _>("options"),
                        "required": r.get::<bool, _>("required"),
                    })
                })
                .collect();
            json!({ "board_id": id, "board": name, "columns": columns, "fields": fields })
        })
        .collect();
    Ok(json!({ "data": data }))
}
