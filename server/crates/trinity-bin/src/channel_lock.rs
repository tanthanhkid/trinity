//! `trinity channel-lock` (K32): công tắc của chủ nền tảng cho kênh gửi ra ngoài của một công ty (thay
//! `packages/prisma/scripts/channel-lock.cjs`). Khoá ⇒ mọi lượt gửi ra ngoài của công ty đó bị từ chối (Messenger, Zalo, trả lời
//! bình luận, bài đăng, gửi hàng loạt); webhook vào vẫn chạy. Luôn chạy ở chế độ đa công ty (như bản Node đặt `MULTI_TENANT=true`).

use std::io::Write;
use std::process::ExitCode;

use clap::{Args, Subcommand};
use sqlx::types::chrono::{DateTime, Utc};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};

#[derive(Debug, Args)]
pub struct ChannelLockArgs {
    #[command(subcommand)]
    action: Action,
}

#[derive(Debug, Subcommand)]
enum Action {
    /// Liệt kê mọi công ty kèm trạng thái khoá.
    List,
    /// Khoá kênh gửi ra ngoài của một công ty.
    Lock {
        company_id: i64,
        /// Lý do (ghép các từ; trống ⇒ lý do mặc định). Nhận cả từ bắt đầu bằng `-`.
        #[arg(allow_hyphen_values = true)]
        reason: Vec<String>,
    },
    /// Mở khoá.
    Unlock { company_id: i64 },
    /// Kết thúc sớm một lần tạm dừng tự động.
    Resume { company_id: i64 },
}

fn out(line: &str) {
    let _ = writeln!(std::io::stdout(), "{line}");
}

fn err(line: &str) {
    let _ = writeln!(std::io::stderr(), "{line}");
}

pub fn run(args: ChannelLockArgs) -> ExitCode {
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            err(&format!("không tạo được runtime: {e}"));
            return ExitCode::FAILURE;
        }
    };
    rt.block_on(run_async(args.action))
}

/// Id công ty hợp lệ (số nguyên ≥ 1); sai ⇒ mã thoát 2 như `usage()` của bản Node.
fn company_id(id: i64) -> Result<i32, ExitCode> {
    i32::try_from(id).ok().filter(|i| *i >= 1).ok_or_else(|| {
        err("Usage: channel-lock list | lock <companyId> [reason] | unlock <companyId> | resume <companyId>");
        ExitCode::from(2)
    })
}

async fn run_async(action: Action) -> ExitCode {
    match run_inner(action).await {
        Ok(code) => code,
        Err(e) => {
            err(&format!("trinity channel-lock: {e}"));
            ExitCode::FAILURE
        }
    }
}

async fn run_inner(action: Action) -> Result<ExitCode, String> {
    // Luôn đa công ty (như bản Node đặt `MULTI_TENANT=true`): đưa cờ vào lúc đọc cấu hình để thứ tự chọn URL cơ sở dữ liệu cũng theo
    // chế độ đa công ty (không chỉ đổi cờ sau khi URL đã chọn).
    let mut cfg = DbConfig::from_lookup(|k| {
        if k == "MULTI_TENANT" {
            Some("true".to_owned())
        } else {
            std::env::var(k).ok()
        }
    })
    .map_err(|e| e.to_string())?;
    cfg.pool_size = 2;
    let db = Db::connect(&cfg).await.map_err(|e| e.to_string())?;
    let platform = Platform::new(&db, std::env::var("DEFAULT_COMPANY_NAME").ok().as_deref());
    let code = exec(&db, &platform, action).await;
    db.close().await;
    code
}

async fn exec(db: &Db, platform: &Platform, action: Action) -> Result<ExitCode, String> {
    match action {
        Action::List => {
            for c in platform.list_channel_locks().await.map_err(|e| e.to_string())? {
                let state = if c.lock.locked { "LOCKED  " } else { "open    " };
                let reason = match (&c.lock.reason, c.lock.locked) {
                    (Some(r), true) if !r.is_empty() => format!("  — {r}"),
                    _ => String::new(),
                };
                out(&format!("{:>4}  {state} {:<10} {}{reason}", c.id, c.status, c.name));
            }
            Ok(ExitCode::SUCCESS)
        }
        Action::Lock { company_id: id, reason } => set(platform, id, true, &reason.join(" ")).await,
        Action::Unlock { company_id: id } => set(platform, id, false, "").await,
        Action::Resume { company_id: id } => {
            let id = match company_id(id) {
                Ok(i) => i,
                Err(c) => return Ok(c),
            };
            let Some(company) = platform
                .active_company(i64::from(id))
                .await
                .map_err(|e| e.to_string())?
            else {
                err(&format!("Company {id} not found or suspended"));
                return Ok(ExitCode::FAILURE);
            };
            if resume(db, company).await? {
                out(&format!(
                    "Company {id}: automatic pause ended (takes effect within a few seconds)"
                ));
            } else {
                out(&format!("Company {id}: no automatic pause in effect"));
            }
            Ok(ExitCode::SUCCESS)
        }
    }
}

async fn set(platform: &Platform, id: i64, lock: bool, reason: &str) -> Result<ExitCode, String> {
    let id = match company_id(id) {
        Ok(i) => i,
        Err(c) => return Ok(c),
    };
    let found = platform
        .set_channel_lock(id, lock, Some(reason))
        .await
        .map_err(|e| e.to_string())?;
    if !found {
        err(&format!("Company {id} not found"));
        return Ok(ExitCode::FAILURE);
    }
    out(&format!(
        "Company {id}: outbound channels {} (takes effect within ~10 seconds on every instance)",
        if lock { "LOCKED" } else { "unlocked" }
    ));
    Ok(ExitCode::SUCCESS)
}

/// Kết thúc sớm lần tạm dừng tự động còn hiệu lực. Chỉ một lần tạm dừng còn ở tương lai: lần đã hết hạn thì đã xong, không có gì
/// để mở lại. `true` ⇒ đã ghi `auto_resume`.
async fn resume(db: &Db, company: CompanyRef) -> Result<bool, String> {
    let mut conn = db
        .tenant(company)
        .await
        .map_err(|e| e.to_string())?
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let last: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT kind, meta ->> 'until' FROM channel_events WHERE kind IN ('auto_pause', 'auto_resume') ORDER BY id DESC LIMIT 1",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let Some((kind, until)) = last else { return Ok(false) };
    let still_paused = kind == "auto_pause"
        && until
            .as_deref()
            .and_then(|u| DateTime::parse_from_rfc3339(u).ok())
            .is_some_and(|u| u.with_timezone(&Utc) > Utc::now());
    if !still_paused {
        return Ok(false);
    }
    sqlx::query(
        "INSERT INTO channel_events (kind, message, meta) VALUES ('auto_resume', 'Chủ nền tảng mở lại gửi tự động', '{}'::jsonb)",
    )
    .execute(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    Ok(true)
}
