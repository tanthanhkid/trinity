//! Cấu hình đọc từ biến môi trường, giữ nguyên tên biến của bản Node (PLAN 4.13).
//!
//! - [`Config::from_env`] đọc một bảng biến (thường là `std::env::vars()`), trả cấu hình đã kiểm cùng danh sách cảnh
//!   báo (biến không còn dùng, giá trị lạ bị thay bằng mặc định), hoặc [`ConfigError`] liệt kê mọi lỗi một lần.
//! - Ở production, secret còn giá trị mẫu `change-me-*` hoặc quá ngắn làm cấu hình lỗi (như `insecureSecrets()` của
//!   bản Node); binary thoát với mã khác 0.
//! - Biến chưa có trường riêng đọc qua [`Config::var`], chỉ nhận tên có trong [`vars::ENV_VARS`].

mod base_url;
mod secrets;
pub mod vars;

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;

pub use base_url::{ExternalApis, api_base_url, is_loopback_host};
pub use secrets::insecure_secrets;
use vars::VarKind;

/// Bảng biến môi trường đã đọc (tên → giá trị).
pub type EnvMap = BTreeMap<String, String>;

/// Đọc toàn bộ biến môi trường của tiến trình (bỏ biến có giá trị không phải UTF-8).
pub fn process_env() -> EnvMap {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

/// Chế độ TLS của cổng chính (PLAN 4.13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TlsMode {
    /// HTTP thường (TLS do Caddy/nginx/Cloudflare lo).
    Off,
    /// Binary tự phục vụ TLS từ hai tệp PEM.
    Files { cert: PathBuf, key: PathBuf },
}

/// Cấu hình đã kiểm.
#[derive(Clone)]
pub struct Config {
    /// `NODE_ENV` (mặc định `development`).
    pub node_env: String,
    /// Cổng chính (`TRINITY_HTTP_PORT`, mặc định 3000). `PORT` của bản Node bị bỏ qua.
    pub http_port: u16,
    /// Cổng tương thích cho `/notif-ws` và `/api/v1` (`COMPAT_API_PORT`, mặc định 4000).
    pub compat_api_port: u16,
    /// `DATABASE_URL`.
    pub database_url: Option<String>,
    /// Kích thước pool dùng chung (`DB_POOL_SIZE`, rồi `PRISMA_CONNECTION_LIMIT`, mặc định 8).
    pub db_pool_size: u32,
    /// Khoá ký JWT (`JWT_SECRET`, bắt buộc).
    pub jwt_secret: String,
    /// Bí mật gọi giữa các tiến trình: `INTERNAL_SERVICE_SECRET`, không có thì `SERVICE_SECRET`.
    pub service_secret: Option<String>,
    /// `CORS_ORIGIN` nguyên văn (mặc định `http://localhost:3000`); luật so khớp ở crate http.
    pub cors_origin: String,
    /// `MULTI_TENANT=true`.
    pub multi_tenant: bool,
    /// Tài liệu API `/docs`: ngoài production, hoặc `SWAGGER_ENABLED=true`.
    pub swagger_enabled: bool,
    /// Tệp sở hữu route và job (`TRINITY_OWNERSHIP_FILE`), đọc bằng [`crate::ownership`].
    pub ownership_file: Option<PathBuf>,
    /// Địa chỉ gốc của Graph API và Zalo (G15).
    pub external_apis: ExternalApis,
    /// Trần video đăng bài, MB nguyên 1..=200 (`SOCIAL_MAX_VIDEO_MB`, mặc định 200).
    pub social_max_video_mb: u32,
    /// `TLS_MODE` (`off` | `files`).
    pub tls: TlsMode,
    vars: BTreeMap<&'static str, String>,
}

impl fmt::Debug for Config {
    // Không in giá trị secret.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("node_env", &self.node_env)
            .field("http_port", &self.http_port)
            .field("compat_api_port", &self.compat_api_port)
            .field("db_pool_size", &self.db_pool_size)
            .field("multi_tenant", &self.multi_tenant)
            .field("swagger_enabled", &self.swagger_enabled)
            .field("ownership_file", &self.ownership_file)
            .field("external_apis", &self.external_apis)
            .field("social_max_video_mb", &self.social_max_video_mb)
            .field("tls", &self.tls)
            .finish_non_exhaustive()
    }
}

/// Cấu hình kèm cảnh báo cần ghi log lúc khởi động.
#[derive(Debug, Clone)]
pub struct Loaded {
    pub config: Config,
    pub warnings: Vec<String>,
}

/// Cấu hình không dùng được; tiến trình phải dừng.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    pub problems: Vec<String>,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Không khởi động: cấu hình không hợp lệ:")?;
        for p in &self.problems {
            write!(f, "\n- {p}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ConfigError {}

const DEFAULT_HTTP_PORT: u16 = 3000;
const DEFAULT_COMPAT_PORT: u16 = 4000;
const DEFAULT_POOL: u32 = 8;
const DEFAULT_CORS: &str = "http://localhost:3000";
const MAX_VIDEO_MB: u32 = 200;

/// Giá trị đã `trim`, rỗng coi như không đặt (như `env.X?.trim()` của bản Node).
fn get<'a>(env: &'a EnvMap, name: &str) -> Option<&'a str> {
    env.get(name).map(|v| v.trim()).filter(|v| !v.is_empty())
}

impl Config {
    /// Đọc và kiểm cấu hình. Gom mọi lỗi rồi trả một lần.
    pub fn from_env(env: &EnvMap) -> Result<Loaded, ConfigError> {
        let mut problems = Vec::new();
        let mut warnings = Vec::new();

        for (name, value) in env {
            if let Some(v) = vars::lookup(name)
                && let VarKind::Retired(why) = v.kind
                && !value.trim().is_empty()
            {
                warnings.push(format!("{name} không còn dùng, bỏ qua: {why}"));
            }
        }

        let node_env = get(env, "NODE_ENV").unwrap_or("development").to_owned();
        let production = node_env == "production";

        if production {
            problems.extend(insecure_secrets(env));
        } else if get(env, "JWT_SECRET").is_none() {
            problems.push("Thiếu JWT_SECRET".to_owned());
        }

        let http_port = port(env, "TRINITY_HTTP_PORT", DEFAULT_HTTP_PORT, &mut problems);
        let compat_api_port = port(env, "COMPAT_API_PORT", DEFAULT_COMPAT_PORT, &mut problems);
        if http_port == compat_api_port {
            problems.push(format!(
                "TRINITY_HTTP_PORT và COMPAT_API_PORT trùng nhau ({http_port}) — cổng chính và cổng tương thích phải khác nhau"
            ));
        }

        let db_pool_size = match (get(env, "DB_POOL_SIZE"), get(env, "PRISMA_CONNECTION_LIMIT")) {
            (Some(v), _) => positive(v, "DB_POOL_SIZE", &mut problems).unwrap_or(DEFAULT_POOL),
            (None, Some(v)) => positive(v, "PRISMA_CONNECTION_LIMIT", &mut problems).unwrap_or(DEFAULT_POOL),
            (None, None) => DEFAULT_POOL,
        };

        let external_apis = ExternalApis::from_env(env).unwrap_or_else(|errs| {
            problems.extend(errs);
            ExternalApis::default()
        });

        let social_max_video_mb = match get(env, "SOCIAL_MAX_VIDEO_MB") {
            None => MAX_VIDEO_MB,
            Some(v) => match v.parse::<u32>() {
                Ok(n) if (1..=MAX_VIDEO_MB).contains(&n) => n,
                // Bản Node lặng lẽ dùng mặc định; bản Rust dùng mặc định và báo một dòng.
                _ => {
                    warnings.push(format!(
                        "SOCIAL_MAX_VIDEO_MB={v} không phải số MB nguyên 1–{MAX_VIDEO_MB}, dùng {MAX_VIDEO_MB}"
                    ));
                    MAX_VIDEO_MB
                }
            },
        };

        let tls = match get(env, "TLS_MODE").unwrap_or("off") {
            "off" => TlsMode::Off,
            "files" => match (get(env, "TLS_CERT_FILE"), get(env, "TLS_KEY_FILE")) {
                (Some(c), Some(k)) => TlsMode::Files {
                    cert: c.into(),
                    key: k.into(),
                },
                _ => {
                    problems.push("TLS_MODE=files cần cả TLS_CERT_FILE và TLS_KEY_FILE".to_owned());
                    TlsMode::Off
                }
            },
            other => {
                problems.push(format!("TLS_MODE={other} không hợp lệ (off | files)"));
                TlsMode::Off
            }
        };

        if !problems.is_empty() {
            return Err(ConfigError { problems });
        }

        let vars = env
            .iter()
            .filter_map(|(k, v)| {
                let known = vars::lookup(k)?;
                (known.kind == VarKind::Server).then(|| (known.name, v.clone()))
            })
            .collect();

        let config = Config {
            swagger_enabled: !production || get(env, "SWAGGER_ENABLED") == Some("true"),
            node_env,
            http_port,
            compat_api_port,
            database_url: get(env, "DATABASE_URL").map(str::to_owned),
            db_pool_size,
            jwt_secret: get(env, "JWT_SECRET").unwrap_or_default().to_owned(),
            service_secret: get(env, "INTERNAL_SERVICE_SECRET")
                .or_else(|| get(env, "SERVICE_SECRET"))
                .map(str::to_owned),
            cors_origin: get(env, "CORS_ORIGIN").unwrap_or(DEFAULT_CORS).to_owned(),
            multi_tenant: get(env, "MULTI_TENANT") == Some("true"),
            ownership_file: get(env, "TRINITY_OWNERSHIP_FILE").map(PathBuf::from),
            external_apis,
            social_max_video_mb,
            tls,
            vars,
        };
        Ok(Loaded { config, warnings })
    }

    /// `NODE_ENV=production`.
    pub fn is_production(&self) -> bool {
        self.node_env == "production"
    }

    /// Giá trị (đã `trim`, rỗng = không đặt) của một biến loại `Server` chưa có trường riêng.
    ///
    /// # Panics
    /// Khi `name` không có trong [`vars::ENV_VARS`] với loại `Server` (lỗi lập trình, bắt bằng test).
    pub fn var(&self, name: &str) -> Option<&str> {
        assert!(
            vars::lookup(name).is_some_and(|v| v.kind == VarKind::Server),
            "biến {name} chưa khai trong config::vars::ENV_VARS (loại Server)"
        );
        self.vars.get(name).map(|v| v.trim()).filter(|v| !v.is_empty())
    }

    /// Biến cờ bật bằng đúng chữ `true` (cách bản Node đọc phần lớn cờ: `process.env.X === 'true'`).
    pub fn flag(&self, name: &str) -> bool {
        self.var(name) == Some("true")
    }
}

fn port(env: &EnvMap, name: &str, default: u16, problems: &mut Vec<String>) -> u16 {
    match get(env, name) {
        None => default,
        Some(v) => match v.parse::<u16>() {
            Ok(p) if p > 0 => p,
            _ => {
                problems.push(format!("{name}={v} không phải số cổng hợp lệ (1–65535)"));
                default
            }
        },
    }
}

fn positive(v: &str, name: &str, problems: &mut Vec<String>) -> Option<u32> {
    match v.parse::<u32>() {
        Ok(n) if n > 0 => Some(n),
        _ => {
            problems.push(format!("{name}={v} phải là số nguyên dương"));
            None
        }
    }
}

#[cfg(test)]
mod tests;
