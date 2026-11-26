//! IP của khách: MỘT hàm cho mọi route (docs/rust/PLAN.md mục 4.13), bản Rust của
//! `packages/rbac-nest/src/client-ip.ts` — cùng bảng ca.
//!
//! IP được xác định MỘT lần ngay khi nhận header ([`client_ip_layer`], đặt trước mọi bộ đọc body) rồi lưu vào
//! extension của request; mọi nơi cần IP gọi [`resolve_client_ip`]. Không file nào khác được đọc `x-real-ip`,
//! `x-forwarded-for`, `cf-connecting-ip` hay địa chỉ kết nối.
//!
//! Thứ tự:
//! 1. Có `x-trinity-client-ip` (do tiến trình biên Trinity ký): kiểm HMAC-SHA256 trên `<giá trị>\n<thời điểm Unix>`,
//!    khoá dẫn bằng HKDF-SHA256 từ `INTERNAL_SERVICE_SECRET` rồi `SERVICE_SECRET`, hạn ±60 giây. Sai hoặc quá hạn ⇒ 400.
//! 2. Không có header ⇒ tiến trình này là biên, áp `TRUSTED_PROXY` lên peer TCP.
//! 3. Kết quả cuối là loopback, cổng mặc định của container, hoặc dấu "không tin được" ⇒ KHÔNG tin được: kiểm Wi-Fi và
//!    chấm công cho qua (không khoá ai) + ghi lỗi cấu hình + dải cảnh báo quản trị; giới hạn tốc độ dùng IP peer.

use std::fs;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use trinity_kernel::config::EnvMap;
use trinity_kernel::error::HttpError;

use super::net::{IpNet, canonical, is_loopback, normalize_ip, parse_default_gateway};

pub const CLIENT_IP_HEADER: &str = "x-trinity-client-ip";
/// Giá trị tiến trình biên ghi khi không xác định được IP khách.
pub const UNTRUSTED_CLIENT_IP: &str = "untrusted";
/// Hạn của chữ ký, giây (hai phía).
pub const CLIENT_IP_MAX_SKEW_SEC: u64 = 60;
const HKDF_INFO: &[u8] = b"trinity x-trinity-client-ip v1";
const GATEWAY_TTL_MS: u64 = 30_000;
const LOG_EVERY_MS: u64 = 10 * 60_000;
const WARNING_TTL_MS: u64 = 24 * 60 * 60_000;

/// Danh sách Cloudflare công bố (<https://www.cloudflare.com/ips/>). Ghi đè bằng `CLOUDFLARE_IP_RANGES`.
pub const DEFAULT_CLOUDFLARE_IP_RANGES: &[&str] = &[
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
];

/// Cờ của bản cũ: nghĩa không khớp chắc chắn giá trị mới nào nên KHÔNG ánh xạ ngầm.
pub const LEGACY_TRUST_FLAGS: &[&str] = &[
    "ATTENDANCE_TRUST_CF_IP",
    "LOGIN_WIFI_TRUST_CF_IP",
    "ATTENDANCE_TRUST_PROXY_HEADERS",
    "LOGIN_WIFI_TRUST_PROXY_HEADERS",
];

/// Bảng "cách triển khai → TRUSTED_PROXY" in ra khi cấu hình sai.
pub const TRUSTED_PROXY_GUIDE: &str = "Cách triển khai → TRUSTED_PROXY (đặt ở tiến trình nhận kết nối đầu tiên):
  Caddy/nginx cùng máy → Next → API (trình quản lý tiến trình)   cidr:127.0.0.1/32
  Như trên, có Cloudflare phía trước Caddy/nginx                 cloudflare-behind:127.0.0.1/32
  Docker Compose, cổng web công bố thẳng                         none
  Docker Compose, Cloudflare nối thẳng cổng web                  cloudflare
  Docker Compose sau Caddy/nginx trên host                       cidr:docker-gateway (hoặc cloudflare-behind:docker-gateway)
  Cloudflare Tunnel (cổng chỉ nghe loopback)                     cloudflare-tunnel
Chi tiết: docs/deployment.md, mục \"Client IP\".";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForwardHeader {
    XForwardedFor,
    XRealIp,
}

/// Một mục của danh sách proxy tin cậy: dải IP hoặc từ khoá `docker-gateway`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyEntry {
    Net(IpNet),
    DockerGateway,
}

/// 5 giá trị của `TRUSTED_PROXY`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustedProxy {
    None,
    Cloudflare,
    CloudflareTunnel,
    Cidr {
        entries: Vec<ProxyEntry>,
        header: ForwardHeader,
    },
    CloudflareBehind {
        entries: Vec<ProxyEntry>,
    },
}

fn split_list(raw: &str) -> Vec<&str> {
    raw.split(|c: char| c.is_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
        .collect()
}

fn parse_entries(list: &str, name: &str) -> Result<Vec<ProxyEntry>, String> {
    let items = split_list(list);
    if items.is_empty() {
        return Err(format!("{name}: danh sách trống"));
    }
    items
        .into_iter()
        .map(|e| {
            if e == "docker-gateway" {
                Ok(ProxyEntry::DockerGateway)
            } else {
                IpNet::parse(e)
                    .map(ProxyEntry::Net)
                    .ok_or_else(|| format!("{name}: \"{e}\" không phải IP/CIDR hợp lệ (hoặc từ khoá docker-gateway)"))
            }
        })
        .collect()
}

/// Đọc `TRUSTED_PROXY`. Giá trị sai ⇒ `Err` (khởi động dừng với thông báo).
pub fn parse_trusted_proxy(raw: Option<&str>) -> Result<TrustedProxy, String> {
    let v = raw.unwrap_or("").trim();
    match v {
        "" | "none" => return Ok(TrustedProxy::None),
        "cloudflare" => return Ok(TrustedProxy::Cloudflare),
        "cloudflare-tunnel" => return Ok(TrustedProxy::CloudflareTunnel),
        _ => {}
    }
    if let Some(rest) = v.strip_prefix("cidr:") {
        let mut parts = rest.split(';');
        let list = parts.next().unwrap_or("");
        let mut header = ForwardHeader::XForwardedFor;
        for opt in parts.map(str::trim).filter(|o| !o.is_empty()) {
            header = match opt.to_ascii_lowercase().as_str() {
                "header=x-forwarded-for" => ForwardHeader::XForwardedFor,
                "header=x-real-ip" => ForwardHeader::XRealIp,
                _ => {
                    return Err(format!(
                        "TRUSTED_PROXY: tuỳ chọn \"{opt}\" không hợp lệ (chỉ có ;header=x-real-ip)"
                    ));
                }
            };
        }
        return Ok(TrustedProxy::Cidr {
            entries: parse_entries(list, "TRUSTED_PROXY cidr:")?,
            header,
        });
    }
    if let Some(rest) = v.strip_prefix("cloudflare-behind:") {
        return Ok(TrustedProxy::CloudflareBehind {
            entries: parse_entries(rest, "TRUSTED_PROXY cloudflare-behind:")?,
        });
    }
    Err(format!("TRUSTED_PROXY=\"{v}\" không hợp lệ.\n{TRUSTED_PROXY_GUIDE}"))
}

fn env_nonempty<'a>(env: &'a EnvMap, name: &str) -> Option<&'a str> {
    env.get(name).map(String::as_str).filter(|v| !v.is_empty())
}

/// Lỗi cấu hình khiến binary KHÔNG được khởi động: `TRUSTED_PROXY`/`CLOUDFLARE_IP_RANGES` sai, hoặc còn cờ cũ
/// (`*_TRUST_CF_IP`, `*_TRUST_PROXY_HEADERS`) bằng đúng `true` mà chưa đặt `TRUSTED_PROXY`. Rỗng = đạt.
pub fn startup_problems(env: &EnvMap) -> Vec<String> {
    let mut out = Vec::new();
    if let Err(e) = parse_trusted_proxy(env.get("TRUSTED_PROXY").map(String::as_str)) {
        out.push(e);
    }
    if let Some(raw) = env_nonempty(env, "CLOUDFLARE_IP_RANGES").filter(|r| !r.trim().is_empty()) {
        if split_list(raw).contains(&"docker-gateway") {
            out.push(
                "CLOUDFLARE_IP_RANGES: từ khoá docker-gateway chỉ dùng trong TRUSTED_PROXY, không phải dải Cloudflare"
                    .to_owned(),
            );
        } else if let Err(e) = parse_entries(raw, "CLOUDFLARE_IP_RANGES") {
            out.push(e);
        }
    }
    let legacy: Vec<&str> = LEGACY_TRUST_FLAGS
        .iter()
        .copied()
        .filter(|k| env.get(*k).is_some_and(|v| v.trim() == "true"))
        .collect();
    if !legacy.is_empty() && env.get("TRUSTED_PROXY").is_none_or(|v| v.trim().is_empty()) {
        out.push(format!(
            "Cờ cũ {} không còn tác dụng và không được tự đổi sang cấu hình mới (nghĩa cũ không khớp chắc chắn giá trị nào). Đặt TRUSTED_PROXY theo cách triển khai rồi xoá cờ cũ.\n{TRUSTED_PROXY_GUIDE}",
            legacy.join(", ")
        ));
    }
    out
}

/// Cảnh báo lúc khởi động (không chặn): cờ cũ còn trong môi trường với giá trị khác `true`.
pub fn startup_warnings(env: &EnvMap) -> Vec<String> {
    let stale: Vec<&str> = LEGACY_TRUST_FLAGS
        .iter()
        .copied()
        .filter(|k| env.get(*k).is_some_and(|v| v.trim() != "true"))
        .collect();
    if stale.is_empty() {
        vec![]
    } else {
        vec![format!(
            "Cờ cũ {} không còn tác dụng (thay bằng TRUSTED_PROXY, docs/deployment.md mục \"Client IP\"); có thể xoá.",
            stale.join(", ")
        )]
    }
}

/// `cloudflare-tunnel` tin `cf-connecting-ip` của mọi peer nên cổng PHẢI chỉ nghe loopback. Trả lỗi khi địa chỉ nghe
/// không phải loopback — caller (binary) dừng tiến trình TRƯỚC khi mở cổng.
pub fn tunnel_listen_problem(address: Option<&str>, env: &EnvMap) -> Option<String> {
    let Ok(TrustedProxy::CloudflareTunnel) = parse_trusted_proxy(env.get("TRUSTED_PROXY").map(String::as_str)) else {
        return None;
    };
    if address.and_then(normalize_ip).is_some_and(|ip| ip.is_loopback()) {
        return None;
    }
    Some(format!(
        "TRUSTED_PROXY=cloudflare-tunnel nhưng tiến trình đang nghe {}, không phải loopback: ai nối thẳng cổng này sẽ tự khai được IP qua cf-connecting-ip. Đặt LISTEN_HOST=127.0.0.1 (API) / HOSTNAME=127.0.0.1 (web), hoặc chọn giá trị TRUSTED_PROXY khác. Docker Compose + Tunnel: không đặt cloudflare-tunnel cho api (web gọi api:4000 qua mạng Docker), xem docs/deployment.md mục \"Client IP\".",
        address.unwrap_or("(không rõ)")
    ))
}

// ---------------------------------------------------------------------------------------------------------------
// Ký và kiểm `x-trinity-client-ip`
// ---------------------------------------------------------------------------------------------------------------

type HmacSha256 = Hmac<Sha256>;

fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    // HMAC nhận khoá mọi độ dài: `new_from_slice` không lỗi.
    let mut m = HmacSha256::new_from_slice(key).expect("HMAC nhận khoá mọi độ dài");
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

/// Khoá ký dẫn từ một bí mật nội bộ (HKDF-SHA256, salt rỗng, info cố định, 32 byte): cùng kết quả với `hkdfSync`.
pub fn derive_client_ip_key(secret: &str) -> [u8; 32] {
    let prk = hmac(&[0u8; 32], &[secret.as_bytes()]);
    hmac(&prk, &[HKDF_INFO, &[1u8]])
}

fn b64url_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n =
            (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..=c.len() {
            out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for ch in s.bytes() {
        let v = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn mac_for(key: &[u8; 32], value: &str, ts: u64) -> [u8; 32] {
    hmac(key, &[value.as_bytes(), b"\n", ts.to_string().as_bytes()])
}

/// Giá trị header `x-trinity-client-ip`: `<ip hoặc untrusted>;<thời điểm Unix>;<HMAC base64url>`. Bên gửi gọi ngay
/// trước khi gửi header sang tiến trình trong (strangler K17).
pub fn sign_client_ip(value: &str, secret: &str, now_sec: u64) -> String {
    let sig = mac_for(&derive_client_ip_key(secret), value, now_sec);
    format!("{value};{now_sec};{}", b64url_encode(&sig))
}

enum Verified {
    Ok(String),
    Bad { error: &'static str, log: String },
}

fn verify_signed(header: &str, keys: &[[u8; 32]], now_sec: u64) -> Verified {
    let bad_format = |log: &str| Verified::Bad {
        error: "Header x-trinity-client-ip sai định dạng",
        log: log.to_owned(),
    };
    let parts: Vec<&str> = header.split(';').collect();
    if parts.len() != 3 {
        return bad_format("sai định dạng");
    }
    let (value, ts_raw, sig_raw) = (parts[0].trim(), parts[1].trim(), parts[2].trim());
    if ts_raw.is_empty() || ts_raw.len() > 12 || !ts_raw.bytes().all(|c| c.is_ascii_digit()) {
        return bad_format("thời điểm sai định dạng");
    }
    let Ok(ts) = ts_raw.parse::<u64>() else {
        return bad_format("thời điểm sai định dạng");
    };
    if now_sec.abs_diff(ts) > CLIENT_IP_MAX_SKEW_SEC {
        return Verified::Bad {
            error: "Header x-trinity-client-ip đã hết hạn",
            log: format!(
                "lệch {} giây (hạn ±{CLIENT_IP_MAX_SKEW_SEC}; đồng hồ hai máy lệch hoặc phát lại)",
                now_sec as i64 - ts as i64
            ),
        };
    }
    if keys.is_empty() {
        return Verified::Bad {
            error: "Máy chủ chưa đặt bí mật nội bộ để kiểm x-trinity-client-ip",
            log: "API chưa đặt INTERNAL_SERVICE_SECRET/SERVICE_SECRET".to_owned(),
        };
    }
    let sig = b64url_decode(sig_raw).unwrap_or_default();
    // So sánh hằng thời gian qua `Mac::verify_slice`.
    let ok = sig.len() == 32
        && keys.iter().any(|k| {
            let mut m = HmacSha256::new_from_slice(k).expect("HMAC nhận khoá mọi độ dài");
            m.update(value.as_bytes());
            m.update(b"\n");
            m.update(ts.to_string().as_bytes());
            m.verify_slice(&sig).is_ok()
        });
    if !ok {
        return Verified::Bad {
            error: "Chữ ký x-trinity-client-ip không hợp lệ",
            log: "chữ ký sai với cả INTERNAL_SERVICE_SECRET và SERVICE_SECRET — lệch bí mật giữa web và API (hoặc header giả)".to_owned(),
        };
    }
    Verified::Ok(value.to_owned())
}

// ---------------------------------------------------------------------------------------------------------------
// Mạng của tiến trình: container, cổng mặc định
// ---------------------------------------------------------------------------------------------------------------

/// Nguồn thông tin "đang chạy trong container" và "cổng mặc định" (đọc lại sau 30 giây: tuyến đổi khi mạng compose được
/// tạo lại). Ngoài container tuyến mặc định là router LAN, không phải cổng Docker ⇒ luật cổng mặc định không áp.
pub enum NetProbe {
    /// Đọc `/proc` và các tệp dấu hiệu container trên máy thật.
    System,
    /// Cho test: bảng tuyến giả (`None` = không có tệp) và cờ trong-container.
    Fixed {
        route_table: Option<String>,
        in_container: bool,
    },
}

impl NetProbe {
    fn in_container(&self) -> bool {
        match self {
            NetProbe::Fixed { in_container, .. } => *in_container,
            NetProbe::System => {
                std::path::Path::new("/.dockerenv").exists()
                    || std::path::Path::new("/run/.containerenv").exists()
                    || fs::read_to_string("/proc/1/cgroup").is_ok_and(|c| {
                        ["docker", "kubepods", "containerd", "libpod"]
                            .iter()
                            .any(|k| c.contains(k))
                    })
            }
        }
    }

    fn route_table(&self) -> Option<String> {
        match self {
            NetProbe::Fixed { route_table, .. } => route_table.clone(),
            NetProbe::System => fs::read_to_string("/proc/net/route").ok(),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Kết quả và bộ xác định
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// Từ header có chữ ký của tiến trình biên.
    Signed,
    /// Tiến trình này tự xác định từ peer.
    Edge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientIp {
    /// IP khách tin được (đã chuẩn hoá); `None` = không tin được, KHÔNG đem so với IP văn phòng.
    pub ip: Option<IpAddr>,
    /// Khoá cho giới hạn tốc độ/nhật ký: `ip`, hoặc IP peer khi không tin được (một xô chung).
    pub rate_key: String,
    /// Lý do không tin được (cho log và dải cảnh báo); `None` khi tin được.
    pub untrusted_reason: Option<String>,
    pub source: Source,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Ok(ClientIp),
    /// Header có chữ ký sai/quá hạn: caller trả 400.
    Bad {
        error: String,
        log: String,
    },
}

/// Phần của request mà việc xác định IP cần: header và địa chỉ kết nối.
pub struct Parts<'a> {
    pub headers: &'a HeaderMap,
    pub peer: Option<IpAddr>,
}

fn header_joined(h: &HeaderMap, name: &str) -> Option<String> {
    let vals: Vec<&str> = h.get_all(name).iter().filter_map(|v| v.to_str().ok()).collect();
    if vals.is_empty() { None } else { Some(vals.join(", ")) }
}

fn rightmost_forwarded(h: &HeaderMap) -> Option<IpAddr> {
    let xff = header_joined(h, "x-forwarded-for")?;
    let last = xff.split(',').map(str::trim).rfind(|s| !s.is_empty())?;
    normalize_ip(last)
}

struct GatewayCache {
    at: u64,
    value: Option<IpAddr>,
}

struct State_ {
    last_untrusted: Option<(u64, String)>,
    logged: std::collections::HashMap<String, u64>,
    gateway: Option<GatewayCache>,
}

/// Bộ xác định IP: cấu hình + trạng thái dải cảnh báo + giới hạn log. Dùng chung qua `Arc` cho cả tiến trình.
pub struct ClientIpResolver {
    proxy: TrustedProxy,
    cloudflare: Vec<IpNet>,
    keys: Vec<[u8; 32]>,
    probe: NetProbe,
    clock_ms: Box<dyn Fn() -> u64 + Send + Sync>,
    state: Mutex<State_>,
    trusted_proxy_raw: String,
}

fn system_clock_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

impl ClientIpResolver {
    /// Dựng từ biến môi trường. Giá trị `TRUSTED_PROXY`/`CLOUDFLARE_IP_RANGES` sai ⇒ `Err` (đã chặn khởi động bằng
    /// [`startup_problems`]; hàm này vẫn trả lỗi để test và caller khác không nuốt).
    pub fn from_env(env: &EnvMap, probe: NetProbe) -> Result<Self, String> {
        let raw = env.get("TRUSTED_PROXY").map(String::as_str);
        let proxy = parse_trusted_proxy(raw)?;
        let cloudflare: Vec<IpNet> = match env_nonempty(env, "CLOUDFLARE_IP_RANGES").filter(|r| !r.trim().is_empty()) {
            Some(r) => {
                let entries = split_list(r);
                if entries.contains(&"docker-gateway") {
                    return Err("CLOUDFLARE_IP_RANGES: từ khoá docker-gateway chỉ dùng trong TRUSTED_PROXY, không phải dải Cloudflare".into());
                }
                parse_entries(r, "CLOUDFLARE_IP_RANGES")?
                    .into_iter()
                    .filter_map(|e| if let ProxyEntry::Net(n) = e { Some(n) } else { None })
                    .collect()
            }
            None => DEFAULT_CLOUDFLARE_IP_RANGES
                .iter()
                .filter_map(|r| IpNet::parse(r))
                .collect(),
        };
        // Cùng thứ tự và cùng luật bỏ giá trị rỗng với guard `@Internal`.
        let mut keys: Vec<[u8; 32]> = Vec::new();
        for name in ["INTERNAL_SERVICE_SECRET", "SERVICE_SECRET"] {
            if let Some(s) = env_nonempty(env, name) {
                let k = derive_client_ip_key(s);
                if !keys.contains(&k) {
                    keys.push(k);
                }
            }
        }
        Ok(Self {
            proxy,
            cloudflare,
            keys,
            probe,
            clock_ms: Box::new(system_clock_ms),
            state: Mutex::new(State_ {
                last_untrusted: None,
                logged: Default::default(),
                gateway: None,
            }),
            trusted_proxy_raw: raw.unwrap_or("").to_owned(),
        })
    }

    /// Chỉ cho test: đồng hồ (ms).
    #[must_use]
    pub fn with_clock(mut self, clock_ms: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        self.clock_ms = Box::new(clock_ms);
        self
    }

    fn now_ms(&self) -> u64 {
        (self.clock_ms)()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State_> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Cổng mặc định của container (null ngoài container).
    fn gateway(&self) -> Option<IpAddr> {
        if !self.probe.in_container() {
            return None;
        }
        let now = self.now_ms();
        let mut st = self.lock();
        if let Some(c) = &st.gateway
            && now.saturating_sub(c.at) < GATEWAY_TTL_MS
        {
            return c.value;
        }
        let value = self.probe.route_table().and_then(|t| parse_default_gateway(&t));
        st.gateway = Some(GatewayCache { at: now, value });
        value
    }

    fn entries_has(&self, entries: &[ProxyEntry], ip: IpAddr) -> bool {
        entries.iter().any(|e| match e {
            ProxyEntry::Net(n) => n.contains(ip),
            ProxyEntry::DockerGateway => self.gateway().is_some_and(|g| canonical(g) == ip),
        })
    }

    fn is_cloudflare(&self, ip: IpAddr) -> bool {
        self.cloudflare.iter().any(|n| n.contains(ip))
    }

    fn proxy_entries(&self) -> Option<&[ProxyEntry]> {
        match &self.proxy {
            TrustedProxy::Cidr { entries, .. } | TrustedProxy::CloudflareBehind { entries } => Some(entries),
            _ => None,
        }
    }

    /// Áp luật "không tin được" lên kết quả cuối, ở MỌI giá trị `TRUSTED_PROXY`.
    fn finalize(
        &self,
        candidate: Option<IpAddr>,
        peer: Option<IpAddr>,
        why: Option<String>,
        source: Source,
    ) -> ClientIp {
        let peer_key = peer.map_or_else(|| "unknown".to_owned(), |p| p.to_string());
        let untrusted = |reason: String| ClientIp {
            ip: None,
            rate_key: peer_key.clone(),
            untrusted_reason: Some(reason),
            source,
        };
        let Some(c) = candidate else {
            return untrusted(why.unwrap_or_else(|| "không xác định được IP khách".to_owned()));
        };
        if is_loopback(c) {
            return untrusted(format!(
                "IP xác định ra là loopback ({c}): có proxy cùng máy phía trước mà TRUSTED_PROXY chưa khai báo nó"
            ));
        }
        if self.gateway().is_some_and(|g| canonical(g) == c) {
            return untrusted(format!(
                "IP xác định ra là cổng mặc định của container ({c}): kết nối đi qua docker-proxy/NAT, hoặc TRUSTED_PROXY ghi sai dải mạng Docker"
            ));
        }
        ClientIp {
            ip: Some(c),
            rate_key: c.to_string(),
            untrusted_reason: None,
            source,
        }
    }

    fn edge_ip(&self, p: &Parts<'_>) -> ClientIp {
        let peer = p.peer.map(canonical);
        let fin = |c: Option<IpAddr>, why: Option<String>| self.finalize(c, peer, why, Source::Edge);
        let Some(peer_ip) = peer else {
            return fin(None, Some("không đọc được địa chỉ kết nối".into()));
        };
        let cf_header = || header_joined(p.headers, "cf-connecting-ip").and_then(|v| normalize_ip(&v));
        // Peer mạng riêng (khách LAN của bản cài tại chỗ) VẪN là khách thật với `none`/`cidr:`.
        match &self.proxy {
            TrustedProxy::None => fin(Some(peer_ip), None),
            TrustedProxy::Cloudflare => {
                if !self.is_cloudflare(peer_ip) {
                    return fin(Some(peer_ip), None);
                }
                let cf = cf_header();
                fin(
                    cf,
                    cf.is_none()
                        .then(|| "kết nối từ dải Cloudflare nhưng thiếu cf-connecting-ip hợp lệ".to_owned()),
                )
            }
            TrustedProxy::CloudflareTunnel => {
                let cf = cf_header();
                fin(
                    cf,
                    cf.is_none().then(|| {
                        "TRUSTED_PROXY=cloudflare-tunnel nhưng request không có cf-connecting-ip hợp lệ".to_owned()
                    }),
                )
            }
            TrustedProxy::Cidr { entries, header } => {
                if !self.entries_has(entries, peer_ip) {
                    return fin(Some(peer_ip), None);
                }
                let (ip, name) = match header {
                    ForwardHeader::XRealIp => (
                        header_joined(p.headers, "x-real-ip").and_then(|v| normalize_ip(&v)),
                        "X-Real-IP",
                    ),
                    ForwardHeader::XForwardedFor => (rightmost_forwarded(p.headers), "X-Forwarded-For"),
                };
                fin(
                    ip,
                    ip.is_none()
                        .then(|| format!("peer {peer_ip} là proxy tin cậy nhưng không gửi {name} hợp lệ")),
                )
            }
            TrustedProxy::CloudflareBehind { entries } => {
                if !self.entries_has(entries, peer_ip) {
                    return fin(Some(peer_ip), None);
                }
                let Some(hop) = rightmost_forwarded(p.headers) else {
                    return fin(
                        None,
                        Some(format!(
                            "peer {peer_ip} là proxy tin cậy nhưng không gửi X-Forwarded-For hợp lệ"
                        )),
                    );
                };
                if !self.is_cloudflare(hop) {
                    return fin(Some(hop), None);
                }
                let cf = cf_header();
                fin(
                    cf,
                    cf.is_none()
                        .then(|| "kết nối từ dải Cloudflare nhưng thiếu cf-connecting-ip hợp lệ".to_owned()),
                )
            }
        }
    }

    /// Xác định IP của một request (không lưu). Header có chữ ký sai/quá hạn ⇒ [`Decision::Bad`] (caller trả 400).
    pub fn determine(&self, p: &Parts<'_>) -> Decision {
        let Some(signed) = header_joined(p.headers, CLIENT_IP_HEADER) else {
            return Decision::Ok(self.edge_ip(p));
        };
        let peer = p.peer.map(canonical);
        // Dấu `untrusted` KHÔNG chữ ký (web thiếu bí mật nội bộ): chỉ nhận khi peer là loopback hoặc proxy khai trong
        // TRUSTED_PROXY. Ai gọi thẳng API mà gửi dấu này (để tắt kiểm Wi-Fi/chấm công) thì header bị bỏ qua.
        if signed.trim() == UNTRUSTED_CLIENT_IP {
            let own_proxy =
                peer.is_some_and(|ip| is_loopback(ip) || self.proxy_entries().is_some_and(|e| self.entries_has(e, ip)));
            if !own_proxy {
                return Decision::Ok(self.edge_ip(p));
            }
            return Decision::Ok(self.finalize(None, peer, Some("tiến trình phía trước (web) không ký được IP khách: thiếu INTERNAL_SERVICE_SECRET/SERVICE_SECRET ở web".into()), Source::Signed));
        }
        let now_sec = self.now_ms() / 1000;
        let value = match verify_signed(&signed, &self.keys, now_sec) {
            Verified::Ok(v) => v,
            Verified::Bad { error, log } => {
                return Decision::Bad {
                    error: error.to_owned(),
                    log,
                };
            }
        };
        if value == UNTRUSTED_CLIENT_IP {
            return Decision::Ok(self.finalize(None, peer, Some("tiến trình biên (web) không xác định được IP khách: thiếu tệp nạp trước hoặc thiếu bí mật nội bộ".into()), Source::Signed));
        }
        let Some(ip) = normalize_ip(&value) else {
            return Decision::Bad {
                error: "Header x-trinity-client-ip sai định dạng".into(),
                log: "giá trị không phải IP".into(),
            };
        };
        Decision::Ok(self.finalize(Some(ip), peer, None, Source::Signed))
    }

    fn log_once(&self, key: &str, msg: &str) {
        let now = self.now_ms();
        {
            let mut st = self.lock();
            if st
                .logged
                .get(key)
                .is_some_and(|prev| now.saturating_sub(*prev) < LOG_EVERY_MS)
            {
                return;
            }
            st.logged.insert(key.to_owned(), now);
        }
        tracing::error!("{msg}");
    }

    /// IP khách đã lưu của request — hàm DUY NHẤT mọi nơi dùng. Request chưa qua [`client_ip_layer`] thì xác định tại
    /// chỗ (chữ ký sai coi như không tin được). Kết quả không tin được ⇒ ghi lỗi cấu hình (tối đa 10 phút một dòng
    /// mỗi lý do) và bật dải cảnh báo quản trị.
    pub fn resolve(&self, req_ext: Option<&ClientIp>, p: &Parts<'_>) -> ClientIp {
        let client = match req_ext {
            Some(c) => c.clone(),
            None => match self.determine(p) {
                Decision::Ok(c) => c,
                Decision::Bad { log, .. } => ClientIp {
                    ip: None,
                    rate_key: p
                        .peer
                        .map_or_else(|| "unknown".to_owned(), |x| canonical(x).to_string()),
                    untrusted_reason: Some(format!("header {CLIENT_IP_HEADER} không hợp lệ: {log}")),
                    source: Source::Signed,
                },
            },
        };
        if let Some(reason) = &client.untrusted_reason {
            self.lock().last_untrusted = Some((self.now_ms(), reason.clone()));
            let shown = if self.trusted_proxy_raw.is_empty() {
                "(trống = none)"
            } else {
                &self.trusted_proxy_raw
            };
            self.log_once(
                &format!("untrusted:{reason}"),
                &format!("[client-ip] LỖI CẤU HÌNH: {reason}. Kiểm Wi-Fi đăng nhập và kiểm IP chấm công đang CHO QUA (không khoá ai), giới hạn tốc độ dùng chung một xô theo IP peer. Sửa TRUSTED_PROXY (TRUSTED_PROXY={shown})."),
            );
        }
        client
    }

    /// Câu cảnh báo cho quản trị khi trong 24 giờ qua có request dùng IP không tin được; `None` = ổn. Request tin được
    /// xen giữa không tắt cảnh báo (không nhấp nháy); sửa cấu hình cần khởi động lại nên trạng thái tự xoá.
    pub fn warning(&self) -> Option<String> {
        let (at, reason) = self.lock().last_untrusted.clone()?;
        if self.now_ms().saturating_sub(at) > WARNING_TTL_MS {
            return None;
        }
        Some(format!(
            "Máy chủ không xác định được IP thật của người dùng ({reason}). Kiểm IP văn phòng khi đăng nhập và chấm công đang tạm cho qua. Người vận hành cần đặt TRUSTED_PROXY đúng cách triển khai (xem docs/deployment.md, mục \"Client IP\")."
        ))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Axum
// ---------------------------------------------------------------------------------------------------------------

/// Lớp middleware xác định IP — đăng ký TRƯỚC mọi bộ đọc body (JSON, form, multipart, stream). Kiểm chữ ký ngay khi
/// nhận header (body chậm không làm chữ ký hết hạn), lưu [`ClientIp`] vào extension. Chữ ký sai/quá hạn ⇒ 400.
///
/// `axum::middleware::from_fn_with_state(resolver, client_ip_layer)`; server phải dùng
/// `into_make_service_with_connect_info::<SocketAddr>()` để có địa chỉ peer.
pub async fn client_ip_layer(State(r): State<Arc<ClientIpResolver>>, mut req: Request, next: Next) -> Response {
    let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip());
    match r.determine(&Parts {
        headers: req.headers(),
        peer,
    }) {
        Decision::Bad { error, log } => {
            r.log_once(
                &format!("bad:{log}"),
                &format!(
                    "[client-ip] từ chối header {CLIENT_IP_HEADER}: {log} (peer {})",
                    peer.map_or_else(|| "?".to_owned(), |p| p.to_string())
                ),
            );
            bad_request(&error)
        }
        Decision::Ok(c) => {
            req.extensions_mut().insert(c);
            next.run(req).await
        }
    }
}

fn bad_request(msg: &str) -> Response {
    let body = serde_json::to_vec(&HttpError::bad_request(msg).body()).unwrap_or_default();
    (
        StatusCode::BAD_REQUEST,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

/// IP khách của request đã qua [`client_ip_layer`] — hàm DUY NHẤT mọi route dùng.
pub fn resolve_client_ip(r: &ClientIpResolver, req: &Request) -> ClientIp {
    let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip());
    r.resolve(
        req.extensions().get::<ClientIp>(),
        &Parts {
            headers: req.headers(),
            peer,
        },
    )
}

#[cfg(test)]
mod tests;
