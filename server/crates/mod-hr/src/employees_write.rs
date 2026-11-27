//! Ghi nhân viên (M10): thêm, sửa, khoá, mở khoá, xoá mềm. Bản TS: `employees.service.ts` (create/update/lock/unlock/remove).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err, clippy::too_many_lines)]

use base64::Engine as _;
use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use mod_users::guards::{
    Actor, assert_user_slot_available, db, record_employment_end, record_employment_start, revoke_pending_by,
    revoke_pending_for_email, scope_err,
};
use serde::Serialize;
use serde_json::json;
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_auth::password;
use trinity_db::CompanyRef;
use trinity_db::pg_error::db_error;
use trinity_db::platform::PlatformError;
use trinity_docgen::image::avatar_jpeg;
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};
use trinity_rbac::{OwnerIds, is_subset};

use crate::employee_dto::{CreateEmployeeDto, UpdateEmployeeDto};
use crate::employees::{Ctx, EmployeeDto, R, fetch_dto, trimmed_or_null};

const MAX_MANAGER_CHAIN_DEPTH: usize = 10;
const AVATAR_MAX_BYTES: usize = 5 * 1024 * 1024;

fn http(e: HttpError) -> AppError {
    AppError::Http(e)
}

fn bad(m: &str) -> AppError {
    http(HttpError::bad_request(m))
}

fn nf() -> AppError {
    http(HttpError::not_found("Không tìm thấy nhân viên"))
}

fn i32_of(v: i64) -> R<i32> {
    i32::try_from(v).map_err(|_| bad("ID không hợp lệ"))
}

static DATE_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    #[allow(clippy::expect_used)]
    regex::Regex::new(
        r"(?i)^(?:[+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[t ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(z|[+-]\d{2}(?::?\d{2})?)?)?$",
    )
    .expect("regex ngày hợp lệ")
});

/// Chuỗi ngày giờ như `new Date(s)` cho mọi dạng `@IsDateString` nhận: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, kèm `T` hoặc dấu
/// cách + `HH:mm[:ss[.fff]]` + `Z`, `±HH:mm`, `±HHmm`, `±HH`. Không có múi giờ thì UTC (máy chủ Node chạy `TZ=UTC`). Tháng 1..12,
/// ngày 1..31 (ngày 31 của tháng 30 ngày tràn sang tháng sau như V8), `24:00` được.
pub(crate) fn instant(s: &str) -> R<DateTime<Utc>> {
    let invalid = || bad("Ngày không hợp lệ");
    let t = s.trim();
    let caps = DATE_RE.captures(t).ok_or_else(invalid)?;
    let n = |i: usize| caps.get(i).and_then(|m| m.as_str().parse::<u32>().ok());
    let year_end = t.find('-').filter(|i| *i >= 4).unwrap_or(4);
    let year: i32 = if t.starts_with(['+', '-']) {
        t[..7].parse().map_err(|_| invalid())?
    } else {
        t[..year_end.min(4)].parse().map_err(|_| invalid())?
    };
    let (month, day) = (n(1).unwrap_or(1), n(2).unwrap_or(1));
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(invalid());
    }
    let first = NaiveDate::from_ymd_opt(year, month, 1).ok_or_else(invalid)?;
    let date = first
        .checked_add_days(chrono::Days::new(u64::from(day - 1)))
        .ok_or_else(invalid)?;
    let (h, mi, sec) = (n(3).unwrap_or(0), n(4).unwrap_or(0), n(5).unwrap_or(0));
    if mi > 59 || sec > 59 || h > 24 || (h == 24 && (mi != 0 || sec != 0)) {
        return Err(invalid());
    }
    let millis: u32 = caps
        .get(6)
        .map(|m| {
            format!("{:0<3}", m.as_str())
                .chars()
                .take(3)
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    let local = date
        .and_time(NaiveTime::MIN)
        .checked_add_signed(chrono::Duration::milliseconds(i64::from(
            ((h * 60 + mi) * 60 + sec) * 1000 + millis,
        )))
        .ok_or_else(invalid)?;
    let offset_min: i64 = match caps.get(7).map(|m| m.as_str()) {
        None => 0,
        Some(z) if z.eq_ignore_ascii_case("z") => 0,
        Some(z) => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let digits: String = z[1..].chars().filter(char::is_ascii_digit).collect();
            let (oh, om) = (
                digits[..2].parse::<i64>().unwrap_or(0),
                digits.get(2..4).map_or(0, |m| m.parse::<i64>().unwrap_or(0)),
            );
            if oh > 23 || om > 59 {
                return Err(invalid());
            }
            sign * (oh * 60 + om)
        }
    };
    Ok((local - chrono::Duration::minutes(offset_min)).and_utc())
}

/// `dto.x ? new Date(dto.x) : null` (chuỗi rỗng ⇒ null).
pub fn opt_instant(v: Option<&str>) -> R<Option<DateTime<Utc>>> {
    v.filter(|s| !s.is_empty()).map(instant).transpose()
}

// ───────────────────────────── quyền ─────────────────────────────

/// Không cho thao tác lên người có quyền cao hơn mình (Quản trị thật, hoặc quyền không ⊆ quyền người gọi).
async fn assert_not_escalating(ctx: &Ctx, actor: &Actor, target: i32) -> R<()> {
    if actor.is_admin {
        return Ok(());
    }
    let t = ctx
        .perms
        .grants_for(actor.company, target)
        .await
        .map_err(AppError::internal)?;
    if t.is_admin || !is_subset(&t.grants, &actor.grants) {
        return Err(http(HttpError::forbidden(
            "Không thể thao tác người có quyền cao hơn bạn",
        )));
    }
    Ok(())
}

/// Ghi vào tài khoản liên kết cần `users.manage` phủ đúng người này (ngoài phạm vi ⇒ 404).
async fn assert_users_manage(ctx: &Ctx, actor: &Actor, target: i32) -> R<()> {
    ctx.scopes
        .assert_in_scope(
            actor.company,
            actor.user_id,
            &actor.grants,
            "users.manage",
            &[Some(target)],
        )
        .await
        .map_err(scope_err)
}

fn assert_not_self(actor: &Actor, target: i32) -> R<()> {
    if actor.user_id == target {
        return Err(http(HttpError::forbidden(
            "Không thể thực hiện thao tác này trên tài khoản của chính mình",
        )));
    }
    Ok(())
}

/// Phạm vi lời mời theo `users.manage`: `None` = mọi lời mời.
async fn invitation_owners(ctx: &Ctx, actor: &Actor) -> R<Option<Vec<i32>>> {
    let o = ctx
        .scopes
        .owner_ids(actor.company, actor.user_id, &actor.grants, "users.manage")
        .await
        .map_err(AppError::internal)?;
    Ok(match o {
        Some(OwnerIds::All) => None,
        Some(OwnerIds::Ids(v)) => Some(v),
        None => Some(Vec::new()),
    })
}

/// Đi ngược chuỗi `manager_id` từ `new_manager`; gặp `user` (hoặc quá sâu/lặp) ⇒ 400.
async fn assert_no_manager_cycle(conn: &mut PgConnection, user: i32, new_manager: i32) -> R<()> {
    if new_manager == user {
        return Err(bad("Phát hiện vòng lặp trong cấu trúc quản lý"));
    }
    let mut cursor = Some(new_manager);
    let mut visited: Vec<i32> = Vec::new();
    for _ in 0..MAX_MANAGER_CHAIN_DEPTH {
        let Some(c) = cursor else { return Ok(()) };
        if c == user {
            return Err(bad("Phát hiện vòng lặp trong cấu trúc quản lý"));
        }
        if visited.contains(&c) {
            return Err(bad("Phát hiện vòng lặp trong cấu trúc quản lý (DB dirty)"));
        }
        visited.push(c);
        let parent: Option<Option<i32>> = sqlx::query_scalar("SELECT manager_id FROM users WHERE id = $1")
            .bind(c)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
        match parent {
            None => return Ok(()),
            Some(p) => cursor = p,
        }
    }
    Err(bad("Chain quản lý vượt quá độ sâu cho phép (có thể có vòng lặp)"))
}

/// Chọn Team ⇒ trưởng nhóm làm quản lý và phòng ban theo team. `None` khi không chọn team.
struct TeamAssign {
    manager: Option<i32>,
    department: Option<String>,
    lead_is_self: bool,
}

async fn apply_team(conn: &mut PgConnection, team: Option<i64>, self_user: Option<i32>) -> R<Option<TeamAssign>> {
    let Some(team) = team else { return Ok(None) };
    let id = i32_of(team)?;
    let row: Option<(Option<i32>, Option<String>)> =
        sqlx::query_as("SELECT team_lead_id, department FROM teams WHERE id = $1")
            .bind(id)
            .fetch_optional(conn)
            .await
            .map_err(db)?;
    let Some((lead, department)) = row else {
        return Err(http(HttpError::not_found(format!("Team #{id} không tồn tại"))));
    };
    Ok(Some(TeamAssign {
        manager: lead,
        department,
        lead_is_self: self_user.is_some() && lead == self_user,
    }))
}

async fn audit(
    ctx: &Ctx,
    company: CompanyRef,
    user: Option<i32>,
    action: &str,
    resource_id: i32,
    metadata: serde_json::Value,
) {
    let res = async {
        let mut c = ctx.conn(company).await?;
        sqlx::query("INSERT INTO audit_logs (user_id, action, resource, resource_id, metadata) VALUES ($1, $2, $3, $4, $5::text::jsonb)")
            .bind(user)
            .bind(action)
            .bind(if action == "password_change" { "users" } else { "employees" })
            .bind(resource_id)
            .bind(metadata.to_string())
            .execute(&mut *c)
            .await
            .map_err(db)?;
        Ok::<(), AppError>(())
    }
    .await;
    if res.is_err() {
        tracing::warn!("không ghi được audit {action} cho {resource_id}");
    }
}

/// `recordEmploymentStatusChange`: vào `resigned` ⇒ đóng giai đoạn, rời `resigned` ⇒ mở giai đoạn mới; đổi khác không chạm.
async fn record_status_change(conn: &mut PgConnection, employee: i32, from: Option<&str>, to: Option<&str>) -> R<()> {
    if to == Some("resigned") && from != Some("resigned") {
        record_employment_end(conn, employee).await
    } else if from == Some("resigned") && to.is_some_and(|t| t != "resigned") {
        record_employment_start(conn, employee).await
    } else {
        Ok(())
    }
}

// ───────────────────────────── ảnh đại diện ─────────────────────────────

fn avatar_subdir(company: CompanyRef) -> String {
    if company.id() == 1 {
        "avatars/".to_owned()
    } else {
        format!("c{}/avatars/", company.id())
    }
}

/// Chuẩn hoá `avatar_url` được gửi: rỗng ⇒ xoá; đường dẫn `/uploads/…` chỉ giữ nguyên khi đúng ảnh hiện tại của chính người
/// này; data-URL JPG/PNG/WebP ⇒ cắt vuông 200×200 JPEG lưu vào kho, trả đường dẫn.
async fn resolve_avatar(
    ctx: &Ctx,
    company: CompanyRef,
    input: Option<&str>,
    current: Option<&str>,
) -> R<Option<String>> {
    let Some(input) = input.filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    if input.starts_with("/uploads/") {
        return if current == Some(input) {
            Ok(Some(input.to_owned()))
        } else {
            Err(bad("Ảnh đại diện không hợp lệ"))
        };
    }
    if !["jpeg", "jpg", "png", "webp"]
        .iter()
        .any(|k| input.starts_with(&format!("data:image/{k};base64,")))
    {
        return Err(bad("Ảnh đại diện không hợp lệ — chỉ chấp nhận JPG, PNG, WebP"));
    }
    let b64: String = input[input.find(',').map_or(0, |i| i + 1)..]
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let unreadable = || bad("Không đọc được file ảnh — vui lòng chọn ảnh JPG, PNG hoặc WebP hợp lệ");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim_end_matches('='))
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(b64.trim_end_matches('=')))
        .map_err(|_| unreadable())?;
    if bytes.is_empty() || bytes.len() > AVATAR_MAX_BYTES {
        return Err(bad("Ảnh đại diện quá lớn — tối đa 5MB"));
    }
    let jpeg = tokio::task::spawn_blocking(move || avatar_jpeg(&bytes))
        .await
        .map_err(|_| unreadable())?
        .map_err(|_| unreadable())?;
    let name = format!(
        "empl_{}_{}.jpg",
        Utc::now().timestamp_millis(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    let sub = avatar_subdir(company);
    ctx.uploads
        .save(&format!("{sub}{name}"), &jpeg.bytes, "image/jpeg")
        .await
        .map_err(|_| unreadable())?;
    Ok(Some(format!("/uploads/{sub}{name}")))
}

/// Xoá file ảnh cũ (chỉ trong thư mục avatar của CHÍNH công ty; best-effort).
async fn delete_avatar_file(ctx: &Ctx, company: CompanyRef, url: Option<&str>) {
    let sub = avatar_subdir(company);
    let Some(url) = url.filter(|u| u.starts_with(&format!("/uploads/{sub}"))) else {
        return;
    };
    let base = url.rsplit('/').next().unwrap_or_default();
    ctx.uploads.remove(&format!("{sub}{base}")).await;
}

// ───────────────────────────── thêm ─────────────────────────────

fn unique_to_409(e: sqlx::Error) -> AppError {
    if db_error(&e).kind == DbErrorKind::UniqueViolation {
        http(HttpError::conflict(
            "Email hoặc số điện thoại đã tồn tại — vui lòng thử lại.",
        ))
    } else {
        db(e)
    }
}

/// `POST /management/employees`: tạo tài khoản + hồ sơ, hoặc gắn hồ sơ vào tài khoản đã có (chưa có vai trò, hoặc đã xoá mềm ⇒
/// khôi phục). Chọn Team ⇒ trưởng nhóm làm quản lý và phòng ban theo team. Tạo/khôi phục người chiếm một chỗ của gói.
pub async fn create(ctx: &Ctx, actor: &Actor, mut dto: CreateEmployeeDto) -> R<EmployeeDto> {
    let company = actor.company;
    let team_id = dto.team_id.map(i32_of).transpose()?;
    let manager_in = dto.manager_id.map(i32_of).transpose()?;
    let ta = {
        let mut c = ctx.conn(company).await?;
        apply_team(&mut c, dto.team_id, None).await?
    };
    let (manager_id, department) = match &ta {
        Some(t) => (t.manager, t.department.clone()),
        None => (manager_in, dto.department.take()),
    };

    // Pha 1 (một kết nối, nhả trước khi gọi dịch vụ khác): tài khoản đã có theo email và các xung đột.
    let existing: Option<(i32, bool, bool, bool, i64)> = {
        let mut conn = ctx.conn(company).await?;
        sqlx::query_as(
            "SELECT u.id, u.deleted_at IS NOT NULL, e.id IS NOT NULL AND e.deleted_at IS NULL, e.deleted_at IS NOT NULL,
               (SELECT count(*) FROM user_roles ur WHERE ur.user_id = u.id)
             FROM users u LEFT JOIN employees e ON e.user_id = u.id WHERE u.email = $1",
        )
        .bind(&dto.email)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?
    };
    if let Some((_, user_deleted, active_employee, _, _)) = existing
        && active_employee
        && !user_deleted
    {
        return Err(http(HttpError::conflict(
            "Email đã được sử dụng cho một nhân viên khác",
        )));
    }
    let restoring_employee = existing.is_some_and(|e| e.3);
    if let Some((_, user_deleted, _, _, roles)) = existing
        && !user_deleted
        && roles > 0
        && !restoring_employee
    {
        return Err(http(HttpError::conflict(
            "Email đang được dùng cho một tài khoản hệ thống khác — vui lòng kiểm tra lại email.",
        )));
    }
    // Pha 2 (không giữ kết nối): quyền lên tài khoản được tái dùng.
    if let Some((uid, _, _, _, roles)) = existing {
        if roles > 0 {
            assert_not_escalating(ctx, actor, uid).await?;
        }
        assert_users_manage(ctx, actor, uid).await?;
    }
    // Pha 3: SĐT, vòng quản lý, chức danh.
    let mut job_title_name: Option<String> = None;
    {
        let mut conn = ctx.conn(company).await?;
        if let Some(phone) = dto.phone.as_deref().filter(|p| !p.is_empty()) {
            let owner: Option<i32> = sqlx::query_scalar(
                "SELECT id FROM users WHERE phone = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR id <> $2) LIMIT 1",
            )
            .bind(phone)
            .bind(existing.map(|e| e.0))
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
            if owner.is_some() {
                return Err(http(HttpError::conflict("Số điện thoại đã được sử dụng")));
            }
        }
        // Tái dùng tài khoản đã có: người quản lý mới không được nằm trong chuỗi quản lý của chính tài khoản đó.
        if let (Some((uid, ..)), Some(m)) = (existing, manager_id) {
            assert_no_manager_cycle(&mut conn, uid, m).await?;
        }
        if let Some(jt) = dto.job_title_id {
            let id = i32_of(jt)?;
            let name: Option<String> = sqlx::query_scalar("SELECT name FROM job_titles WHERE id = $1")
                .bind(id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?;
            job_title_name =
                Some(name.ok_or_else(|| http(HttpError::not_found(format!("Chức danh #{id} không tồn tại"))))?);
        }
    }
    // Pha 4 (không giữ kết nối): phạm vi lời mời, email giữa các công ty.
    let takes_slot = existing.is_none_or(|e| e.1);
    let owners = if takes_slot {
        invitation_owners(ctx, actor).await?
    } else {
        None
    };
    if existing.is_none() {
        ctx.platform
            .assert_email_available(&dto.email, company)
            .await
            .map_err(|e| match e {
                PlatformError::Conflict(m) => http(HttpError::conflict(m)),
                other => AppError::internal(other),
            })?;
    }

    let pw = dto
        .password
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let had_password = dto.password.as_deref().is_some_and(|p| !p.is_empty());
    let hash = password::hash(pw).await.map_err(AppError::internal)?;
    let avatar = resolve_avatar(ctx, company, dto.avatar_url.as_deref(), None).await?;

    let mut tx = ctx.begin(company).await?;
    if takes_slot {
        revoke_pending_for_email(&mut tx, company, &dto.email, owners.as_deref()).await?;
        assert_user_slot_available(&mut tx, company, ctx.platform.multi_tenant()).await?;
    }
    let (user_id, password_method) = match existing {
        Some((uid, user_deleted, ..)) => {
            let mut qb = QueryBuilder::<Postgres>::new("UPDATE users SET updated_at = now(), full_name = ");
            qb.push_bind(dto.full_name.clone())
                .push(", phone = ")
                .push_bind(dto.phone.clone())
                .push(", team_id = ")
                .push_bind(team_id)
                .push(", manager_id = ")
                .push_bind(manager_id);
            if let Some(a) = &avatar {
                qb.push(", avatar_url = ").push_bind(a.clone());
            }
            if had_password {
                qb.push(", password_hash = ")
                    .push_bind(hash.clone())
                    .push(", password_updated_at = now(), tokens_valid_after = now()");
            }
            if user_deleted {
                qb.push(", deleted_at = NULL, status = 'active'");
            }
            qb.push(" WHERE id = ").push_bind(uid);
            qb.build().execute(&mut *tx).await.map_err(unique_to_409)?;
            (uid, had_password.then_some("employee_reuse_password_set"))
        }
        None => {
            let id: i32 = sqlx::query_scalar(
                "INSERT INTO users (email, full_name, password_hash, password_updated_at, phone, team_id, manager_id, avatar_url, updated_at)
                 VALUES ($1, $2, $3, now(), $4, $5, $6, $7, now()) RETURNING id",
            )
            .bind(&dto.email)
            .bind(&dto.full_name)
            .bind(&hash)
            .bind(&dto.phone)
            .bind(team_id)
            .bind(manager_id)
            .bind(&avatar)
            .fetch_one(&mut *tx)
            .await
            .map_err(unique_to_409)?;
            (id, Some("employee_create"))
        }
    };

    let new_status = dto.status.clone().unwrap_or_else(|| "active".to_owned());
    let prev: Option<(i32, String, Option<DateTime<Utc>>)> =
        sqlx::query_as("SELECT id, status, resigned_at FROM employees WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
    if let Some((eid, st, _)) = &prev {
        record_status_change(&mut tx, *eid, Some(st), Some(&new_status)).await?;
    }
    let resigned_at: Option<DateTime<Utc>> = if new_status != "resigned" {
        None
    } else {
        match &prev {
            Some((_, st, at)) if st == "resigned" => *at,
            _ => Some(Utc::now()),
        }
    };
    let position = dto
        .position
        .as_deref()
        .map(|p| trinity_kernel::vi::trim_js(p).to_owned())
        .filter(|p| !p.is_empty())
        .or(job_title_name)
        .unwrap_or_else(|| "Chưa phân loại".to_owned());
    let joined = dto
        .joined_at
        .as_deref()
        .map(instant)
        .transpose()?
        .unwrap_or_else(Utc::now);
    let eid: i32 = sqlx::query_scalar(
        "INSERT INTO employees (user_id, employee_code, position, department, gender, team_id, salary_rule_id, insurance_salary, job_title_id,
           education_level, recruitment_source, office_id, status, deleted_at, resigned_at, joined_at, birth_date, id_card_number, id_card_issued_date, id_card_issued_place,
           permanent_address, current_address, bank_account_number, bank_name, bank_account_holder)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $22, $23, $24, $10, NULL, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
         ON CONFLICT (user_id) DO UPDATE SET employee_code = EXCLUDED.employee_code, position = EXCLUDED.position,
           department = EXCLUDED.department, gender = EXCLUDED.gender, team_id = EXCLUDED.team_id,
           salary_rule_id = EXCLUDED.salary_rule_id, insurance_salary = EXCLUDED.insurance_salary, job_title_id = EXCLUDED.job_title_id,
           education_level = EXCLUDED.education_level, recruitment_source = EXCLUDED.recruitment_source, office_id = EXCLUDED.office_id,
           status = EXCLUDED.status, deleted_at = NULL, resigned_at = EXCLUDED.resigned_at, joined_at = EXCLUDED.joined_at,
           birth_date = EXCLUDED.birth_date, id_card_number = EXCLUDED.id_card_number, id_card_issued_date = EXCLUDED.id_card_issued_date,
           id_card_issued_place = EXCLUDED.id_card_issued_place, permanent_address = EXCLUDED.permanent_address,
           current_address = EXCLUDED.current_address, bank_account_number = EXCLUDED.bank_account_number, bank_name = EXCLUDED.bank_name,
           bank_account_holder = EXCLUDED.bank_account_holder
         RETURNING id",
    )
    .bind(user_id)
    .bind(dto.employee_code.as_deref().and_then(trimmed_or_null))
    .bind(position)
    .bind(department)
    .bind(&dto.gender)
    .bind(team_id)
    .bind(dto.salary_rule_id.map(i32_of).transpose()?)
    .bind(dto.insurance_salary)
    .bind(dto.job_title_id.map(i32_of).transpose()?)
    .bind(&new_status)
    .bind(resigned_at)
    .bind(joined)
    .bind(opt_instant(dto.birth_date.as_deref())?)
    .bind(dto.id_card_number.as_deref().and_then(trimmed_or_null))
    .bind(opt_instant(dto.id_card_issued_date.as_deref())?)
    .bind(dto.id_card_issued_place.as_deref().and_then(trimmed_or_null))
    .bind(dto.permanent_address.as_deref().and_then(trimmed_or_null))
    .bind(dto.current_address.as_deref().and_then(trimmed_or_null))
    .bind(dto.bank_account_number.as_deref().and_then(trimmed_or_null))
    .bind(dto.bank_name.as_deref().and_then(trimmed_or_null))
    .bind(dto.bank_account_holder.as_deref().and_then(trimmed_or_null))
    .bind(&dto.education_level)
    .bind(&dto.recruitment_source)
    .bind(dto.office_id.map(i32_of).transpose()?)
    .fetch_one(&mut *tx)
    .await
    .map_err(unique_to_409)?;
    tx.commit().await.map_err(AppError::internal)?;

    if let Some(method) = password_method {
        audit(
            ctx,
            company,
            Some(actor.user_id),
            "password_change",
            user_id,
            json!({ "method": method, "target_user_id": user_id }),
        )
        .await;
    }
    ctx.invalidate_all(company).await;
    fetch_dto(ctx, company, eid).await
}

// ───────────────────────────── sửa ─────────────────────────────

/// `PATCH /management/employees/:id`: ghi cả tài khoản liên kết nên cần `users.manage` phủ người này và quyền của target ⊆
/// quyền người gọi. Đổi `status` sang/khỏi `resigned` đóng/mở giai đoạn làm việc; lưu lại hồ sơ vẫn `resigned` không dời ngày
/// nghỉ. Ảnh đại diện đổi hoặc bỏ ⇒ xoá file cũ sau khi ghi thành công.
pub async fn update(ctx: &Ctx, actor: &Actor, id: i32, mut dto: UpdateEmployeeDto) -> R<EmployeeDto> {
    let company = actor.company;
    let emp: Option<(i32, Option<String>)> = {
        let mut conn = ctx.conn(company).await?;
        sqlx::query_as(
            "SELECT e.user_id, u.avatar_url FROM employees e JOIN users u ON u.id = e.user_id WHERE e.id = $1",
        )
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?
    };
    let (user_id, old_avatar) = emp.ok_or_else(nf)?;
    // Các kiểm quyền dùng kết nối riêng của dịch vụ quyền: chạy khi KHÔNG giữ kết nối.
    assert_users_manage(ctx, actor, user_id).await?;
    assert_not_escalating(ctx, actor, user_id).await?;
    let mut conn = ctx.conn(company).await?;

    if let Some(Some(phone)) = dto
        .phone
        .as_ref()
        .filter(|p| p.as_deref().is_some_and(|s| !s.is_empty()))
    {
        let owner: Option<i32> =
            sqlx::query_scalar("SELECT id FROM users WHERE phone = $1 AND deleted_at IS NULL AND id <> $2 LIMIT 1")
                .bind(phone)
                .bind(user_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?;
        if owner.is_some() {
            return Err(http(HttpError::conflict("Số điện thoại đã được sử dụng")));
        }
    }
    // Chọn Team ⇒ quản lý + phòng ban theo team (chính trưởng nhóm giữ nguyên quản lý hiện tại).
    let team_in = dto.team_id;
    if let Some(Some(t)) = &team_in
        && let Some(ta) = apply_team(&mut conn, Some(*t), Some(user_id)).await?
    {
        if !ta.lead_is_self {
            dto.manager_id = Some(ta.manager.map(i64::from));
        } else {
            dto.manager_id = None;
        }
        dto.department = Some(ta.department);
    }
    let manager_in = match &dto.manager_id {
        Some(Some(m)) => {
            let m = i32_of(*m)?;
            if m == user_id {
                return Err(http(HttpError::forbidden(
                    "Không thể tự đặt làm quản lý của chính mình",
                )));
            }
            assert_no_manager_cycle(&mut conn, user_id, m).await?;
            Some(Some(m))
        }
        Some(None) => Some(None),
        None => None,
    };
    let team_sync: Option<Option<i32>> = match &team_in {
        Some(t) => Some(t.map(i32_of).transpose()?),
        None => None,
    };

    let avatar = match &dto.avatar_url {
        None => None,
        Some(v) => Some(resolve_avatar(ctx, company, v.as_deref(), old_avatar.as_deref()).await?),
    };
    let job_title = match &dto.job_title_id {
        Some(Some(j)) => {
            let jid = i32_of(*j)?;
            let found: Option<i32> = sqlx::query_scalar("SELECT id FROM job_titles WHERE id = $1")
                .bind(jid)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?;
            found.ok_or_else(|| http(HttpError::not_found(format!("Chức danh #{jid} không tồn tại"))))?;
            Some(Some(jid))
        }
        Some(None) => Some(None),
        None => None,
    };
    drop(conn);

    let mut tx = ctx.begin(company).await?;
    let mut users_changed = false;
    {
        let mut qb = QueryBuilder::<Postgres>::new("UPDATE users SET updated_at = now()");
        if let Some(Some(v)) = &dto.full_name {
            users_changed = true;
            qb.push(", full_name = ").push_bind(v.clone());
        }
        if let Some(v) = &dto.phone {
            users_changed = true;
            qb.push(", phone = ").push_bind(v.clone());
        }
        if let Some(v) = team_sync {
            users_changed = true;
            qb.push(", team_id = ").push_bind(v);
        }
        if let Some(v) = manager_in {
            users_changed = true;
            qb.push(", manager_id = ").push_bind(v);
        }
        if let Some(v) = &avatar {
            users_changed = true;
            qb.push(", avatar_url = ").push_bind(v.clone());
        }
        if users_changed {
            qb.push(" WHERE id = ").push_bind(user_id);
            qb.build().execute(&mut *tx).await.map_err(unique_to_409)?;
        }
    }

    let mut resigned_at_clause = None::<Option<DateTime<Utc>>>;
    if let Some(Some(status)) = &dto.status {
        let before: Option<String> = sqlx::query_scalar("SELECT status FROM employees WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        record_status_change(&mut tx, id, before.as_deref(), Some(status)).await?;
        // Lưu lại hồ sơ vẫn `resigned` ⇒ KHÔNG dời ngày nghỉ sang hôm nay.
        resigned_at_clause = if before.as_deref() == Some("resigned") && status == "resigned" {
            None
        } else {
            Some((status == "resigned").then(Utc::now))
        };
    }
    let mut qb = QueryBuilder::<Postgres>::new("UPDATE employees SET id = id");
    macro_rules! text {
        ($col:literal, $f:ident) => {
            if let Some(v) = &dto.$f {
                qb.push(concat!(", ", $col, " = "))
                    .push_bind(v.as_deref().and_then(trimmed_or_null));
            }
        };
    }
    macro_rules! raw {
        ($col:literal, $f:ident) => {
            if let Some(v) = &dto.$f {
                qb.push(concat!(", ", $col, " = ")).push_bind(v.clone());
            }
        };
    }
    text!("employee_code", employee_code);
    if let Some(Some(p)) = &dto.position {
        qb.push(", position = ").push_bind(p.clone());
    }
    raw!("department", department);
    raw!("gender", gender);
    raw!("education_level", education_level);
    raw!("recruitment_source", recruitment_source);
    if let Some(Some(s)) = &dto.status {
        qb.push(", status = ").push_bind(s.clone());
    }
    if let Some(at) = resigned_at_clause {
        qb.push(", resigned_at = ").push_bind(at);
    }
    if let Some(Some(j)) = &dto.joined_at {
        qb.push(", joined_at = ").push_bind(instant(j)?);
    }
    if let Some(v) = &dto.salary_rule_id {
        qb.push(", salary_rule_id = ").push_bind(v.map(i32_of).transpose()?);
    }
    raw!("insurance_salary", insurance_salary);
    if let Some(v) = job_title {
        qb.push(", job_title_id = ").push_bind(v);
    }
    if let Some(v) = &dto.office_id {
        qb.push(", office_id = ").push_bind(v.map(i32_of).transpose()?);
    }
    if let Some(v) = &dto.birth_date {
        qb.push(", birth_date = ").push_bind(opt_instant(v.as_deref())?);
    }
    text!("id_card_number", id_card_number);
    if let Some(v) = &dto.id_card_issued_date {
        qb.push(", id_card_issued_date = ")
            .push_bind(opt_instant(v.as_deref())?);
    }
    text!("id_card_issued_place", id_card_issued_place);
    text!("permanent_address", permanent_address);
    text!("current_address", current_address);
    text!("bank_account_number", bank_account_number);
    text!("bank_name", bank_name);
    text!("bank_account_holder", bank_account_holder);
    if let Some(v) = team_sync {
        qb.push(", team_id = ").push_bind(v);
    }
    qb.push(" WHERE id = ").push_bind(id);
    qb.build().execute(&mut *tx).await.map_err(unique_to_409)?;
    tx.commit().await.map_err(AppError::internal)?;

    if let Some(new) = &avatar
        && new.as_deref() != old_avatar.as_deref()
    {
        delete_avatar_file(ctx, company, old_avatar.as_deref()).await;
    }
    if users_changed {
        ctx.invalidate_all(company).await;
    }
    fetch_dto(ctx, company, id).await
}

// ───────────────────────────── khoá, mở khoá, xoá ─────────────────────────────

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct OkMessage {
    pub ok: bool,
    pub message: &'static str,
}

/// `PATCH /management/employees/:id/lock`: khoá tài khoản (thu hồi token cũ, huỷ lời mời chờ của người này), đóng giai đoạn
/// làm việc, nhân viên thành `resigned` (giữ ngày nghỉ cũ nếu đã nghỉ).
pub async fn lock(ctx: &Ctx, actor: &Actor, id: i32) -> R<OkMessage> {
    let company = actor.company;
    let mut conn = ctx.conn(company).await?;
    let user_id: i32 = sqlx::query_scalar("SELECT user_id FROM employees WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?
        .ok_or_else(nf)?;
    drop(conn);
    assert_not_self(actor, user_id)?;
    assert_users_manage(ctx, actor, user_id).await?;
    assert_not_escalating(ctx, actor, user_id).await?;

    let mut tx = ctx.begin(company).await?;
    sqlx::query("UPDATE users SET status = 'locked', tokens_valid_after = now(), updated_at = now() WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    revoke_pending_by(&mut tx, company, user_id).await?;
    record_employment_end(&mut tx, id).await?;
    sqlx::query("UPDATE employees SET status = 'resigned', resigned_at = now() WHERE id = $1 AND status <> 'resigned'")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(AppError::internal)?;
    ctx.invalidate_all(company).await;
    tracing::info!(
        "[employee-resign] actor={} employee_id={id} user_id={user_id}",
        actor.user_id
    );
    audit(
        ctx,
        company,
        Some(actor.user_id),
        "employee_lock",
        id,
        json!({ "target_user_id": user_id }),
    )
    .await;
    Ok(OkMessage {
        ok: true,
        message: "Đã khoá tài khoản nhân viên",
    })
}

/// `PATCH /management/employees/:id/unlock`: CHỈ Quản trị; đảo `lock` (tài khoản `active`, nhân viên `active`, xoá ngày nghỉ,
/// mở giai đoạn mới từ hôm nay; khoảng bị khoá KHÔNG được tính lại). Chiếm lại một chỗ của gói. Không tự mở khoá mình.
pub async fn unlock(ctx: &Ctx, actor: &Actor, id: i32) -> R<OkMessage> {
    if !actor.is_admin {
        return Err(http(HttpError::forbidden(
            "Chỉ Quản trị mới mở khoá được tài khoản nhân viên",
        )));
    }
    let company = actor.company;
    let mut conn = ctx.conn(company).await?;
    let row: Option<(i32, String)> = sqlx::query_as(
        "SELECT e.user_id, u.status FROM employees e JOIN users u ON u.id = e.user_id
         WHERE e.id = $1 AND e.deleted_at IS NULL AND u.deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    drop(conn);
    let (user_id, status) = row.ok_or_else(nf)?;
    assert_not_self(actor, user_id)?;
    if status != "locked" {
        return Err(http(HttpError::conflict("Tài khoản này đang không bị khoá")));
    }
    let mut tx = ctx.begin(company).await?;
    assert_user_slot_available(&mut tx, company, ctx.platform.multi_tenant()).await?;
    sqlx::query("UPDATE users SET status = 'active', updated_at = now() WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    record_employment_start(&mut tx, id).await?;
    sqlx::query("UPDATE employees SET status = 'active', resigned_at = NULL WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(AppError::internal)?;
    ctx.invalidate_all(company).await;
    tracing::info!(
        "[employee-unlock] actor={} employee_id={id} user_id={user_id}",
        actor.user_id
    );
    audit(
        ctx,
        company,
        Some(actor.user_id),
        "employee_unlock",
        id,
        json!({ "target_user_id": user_id }),
    )
    .await;
    Ok(OkMessage {
        ok: true,
        message: "Đã mở khoá tài khoản nhân viên",
    })
}

/// `DELETE /management/employees/:id`: xoá mềm hồ sơ và khoá tài khoản (thu hồi token, huỷ lời mời chờ). Khôi phục hồ sơ
/// không tự mở khoá.
pub async fn remove(ctx: &Ctx, actor: &Actor, id: i32) -> R<OkMessage> {
    let company = actor.company;
    let mut conn = ctx.conn(company).await?;
    let user_id: i32 = sqlx::query_scalar("SELECT user_id FROM employees WHERE id = $1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?
        .ok_or_else(nf)?;
    drop(conn);
    assert_not_self(actor, user_id)?;
    // Khác `lock`/`unlock`: bản Node không đòi `users.manage` khi xoá (chỉ `employees.manage` + không leo thang quyền).
    assert_not_escalating(ctx, actor, user_id).await?;
    let mut tx = ctx.begin(company).await?;
    // Đóng giai đoạn làm việc đang mở (khôi phục hồ sơ sau này không tính lại khoảng đã xoá).
    record_employment_end(&mut tx, id).await?;
    sqlx::query("UPDATE employees SET deleted_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    sqlx::query("UPDATE users SET status = 'locked', tokens_valid_after = now(), updated_at = now() WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    revoke_pending_by(&mut tx, company, user_id).await?;
    tx.commit().await.map_err(AppError::internal)?;
    ctx.invalidate_all(company).await;
    tracing::info!(
        "[employee-delete] actor={} employee_id={id} user_id={user_id}",
        actor.user_id
    );
    audit(
        ctx,
        company,
        Some(actor.user_id),
        "employee_delete",
        id,
        json!({ "target_user_id": user_id }),
    )
    .await;
    Ok(OkMessage {
        ok: true,
        message: "Đã xoá nhân viên",
    })
}

#[cfg(test)]
mod tests {
    use super::instant;

    fn ms(s: &str) -> i64 {
        instant(s).unwrap_or_else(|_| panic!("{s}")).timestamp_millis()
    }

    #[test]
    fn nhan_du_dang_is_date_string() {
        let day = ms("2026-01-02");
        assert_eq!(ms("2026-01-02T00:00:00Z"), day);
        assert_eq!(ms("2026-01-02T00:00Z"), day, "HH:MMZ");
        assert_eq!(ms("2026-01-02T07:00:00+0700"), day, "+0700");
        assert_eq!(ms("2026-01-02T07:00:00+07:00"), day);
        assert_eq!(ms("2026-01-02T07:00+07"), day, "+HH");
        assert_eq!(ms("2026-01-02 00:00:00"), day, "dấu cách, không múi giờ ⇒ UTC");
        assert_eq!(ms("2026-01-02 00:00:00.123"), day + 123);
        assert_eq!(ms("2026-01"), ms("2026-01-01"), "YYYY-MM");
        assert_eq!(ms("2026"), ms("2026-01-01"), "YYYY");
        assert_eq!(ms("2026-01-02T24:00:00Z"), day + 86_400_000);
        assert_eq!(ms("  2026-01-02  "), day);
        for bad in [
            "hôm qua",
            "2026-13-01",
            "2026-01-32",
            "2026-01-02T25:00Z",
            "2026-01-02T10:60Z",
            "2026-01-02T10:00+25:00",
            "",
            "26-01-02",
        ] {
            assert!(instant(bad).is_err(), "{bad}");
        }
    }
}
