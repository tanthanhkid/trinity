//! Chặn secret mẫu ở production — bản Rust của `insecureSecrets()` (`apps/monolith/src/bootstrap-app.ts`), giữ
//! nguyên câu báo lỗi.

use super::{EnvMap, get};

fn placeholder(v: Option<&str>) -> bool {
    v.is_some_and(|v| v.to_lowercase().contains("change-me"))
}

/// Danh sách lỗi secret (rỗng = đạt). Không chứa giá trị secret.
pub fn insecure_secrets(env: &EnvMap) -> Vec<String> {
    let mut out = Vec::new();
    for k in ["JWT_SECRET", "SERVICE_SECRET", "INTERNAL_SERVICE_SECRET"] {
        let Some(v) = get(env, k) else { continue };
        if placeholder(Some(v)) {
            out.push(format!(
                "{k} vẫn là giá trị mẫu change-me-* — sinh mới bằng: openssl rand -hex 32"
            ));
        } else if v.encode_utf16().count() < 32 {
            out.push(format!("{k} ngắn hơn 32 ký tự — sinh mới bằng: openssl rand -hex 32"));
        }
    }
    // Bản Node không `trim` hai biến này trước khi so.
    let raw = |k: &str| env.get(k).map(String::as_str).filter(|v| !v.is_empty());
    if placeholder(raw("INTEGRATIONS_SECRET_KEY")) {
        out.push("INTEGRATIONS_SECRET_KEY vẫn là giá trị mẫu — sinh mới bằng: openssl rand -base64 32".to_owned());
    }
    if placeholder(raw("DATABASE_URL")) || placeholder(raw("POSTGRES_PASSWORD")) {
        out.push("Mật khẩu Postgres vẫn là giá trị mẫu change-me-db-password".to_owned());
    }
    if get(env, "JWT_SECRET").is_none() {
        out.push("Thiếu JWT_SECRET".to_owned());
    }
    out
}
