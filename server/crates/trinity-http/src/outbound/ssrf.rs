//! Chống SSRF. Máy chủ thường chạy chung Postgres và các dịch vụ khác, nên một URL trỏ vào `127.0.0.1`, `10.x` hay
//! `169.254.169.254` là đường vào hạ tầng nội bộ.
//!
//! Phòng thủ (giống bản TS):
//! 1. Chỉ `https://`, không `user:pass@`, cổng 443/8443.
//! 2. Phân giải DNS rồi chặn TỪNG địa chỉ (mọi địa chỉ phải công cộng, không chỉ cái đầu tiên).
//! 3. Chống DNS rebinding: lúc gửi không "phân giải, kiểm, rồi để thư viện phân giải lần nữa". [`SafeDnsResolver`] là
//!    bộ phân giải của chính client `reqwest`: kiểm và kết nối dùng CÙNG kết quả. SNI/Host vẫn là tên miền gốc.
//! 4. IP viết thẳng (kể cả dạng thập phân/hex/bát phân, `url` chuẩn hoá theo WHATWG như `new URL` của Node) và IPv6
//!    (kể cả IPv4-mapped, NAT64, 6to4) được kiểm bằng đúng bảng chặn.
//! 5. Không bao giờ theo chuyển hướng (client tạo bởi [`safe_client`]).

use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use url::Url;

/// Cùng một thông điệp cho "không phân giải được" và "phân giải về IP nội bộ": không để người dùng dò mạng nội bộ
/// qua khác biệt thông điệp.
pub const UNREACHABLE_MSG: &str = "Không phân giải được tên miền hoặc địa chỉ không phải IP công cộng";

/// Địa chỉ bị chặn; `Display` là đúng câu bản TS trả cho người dùng.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SsrfBlocked(pub &'static str);

impl SsrfBlocked {
    /// Mã lỗi như `SsrfBlockedError.code` của bản TS.
    pub const CODE: &'static str = "SSRF_BLOCKED";
}

/// Chính sách đích: mặc định (production) chặn mọi địa chỉ nội bộ.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SsrfPolicy {
    /// Cho phép `http://`, cổng bất kỳ và địa chỉ nội bộ. Chỉ bật được khi chạy test/phát triển (xem [`Self::from_env`]).
    pub allow_private: bool,
}

impl SsrfPolicy {
    /// Đọc từ biến môi trường như bản TS (`allowPrivateTargets`): chỉ mở khi `NODE_ENV` là `test` hoặc `development`
    /// VÀ `INTEGRATIONS_ALLOW_PRIVATE_TARGETS` là `true`/`1`. Production KHÔNG BAO GIỜ mở, kể cả khi có cờ.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Self {
        let flag = get("INTEGRATIONS_ALLOW_PRIVATE_TARGETS")
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let node_env = get("NODE_ENV");
        let dev = matches!(node_env.as_deref(), Some("test" | "development"));
        Self {
            allow_private: dev && (flag == "true" || flag == "1"),
        }
    }

    /// [`Self::from_env`] trên biến môi trường của tiến trình.
    pub fn from_process_env() -> Self {
        Self::from_env(|k| std::env::var(k).ok())
    }
}

/// Dải IPv4 bị chặn (địa chỉ gốc, số bit tiền tố).
const BLOCKED_V4: [([u8; 4], u32); 15] = [
    ([0, 0, 0, 0], 8),
    ([10, 0, 0, 0], 8),
    ([100, 64, 0, 0], 10),
    ([127, 0, 0, 0], 8),
    ([169, 254, 0, 0], 16),
    ([172, 16, 0, 0], 12),
    ([192, 0, 0, 0], 24),
    ([192, 0, 2, 0], 24),
    ([192, 88, 99, 0], 24),
    ([192, 168, 0, 0], 16),
    ([198, 18, 0, 0], 15),
    ([198, 51, 100, 0], 24),
    ([203, 0, 113, 0], 24),
    ([224, 0, 0, 0], 4),
    ([240, 0, 0, 0], 4),
];

fn blocked_v4(b: [u8; 4]) -> bool {
    let n = u32::from_be_bytes(b);
    BLOCKED_V4.iter().any(|&(base, bits)| {
        let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
        n & mask == u32::from_be_bytes(base) & mask
    })
}

fn v4_at(b: &[u8; 16], from: usize) -> [u8; 4] {
    [b[from], b[from + 1], b[from + 2], b[from + 3]]
}

fn blocked_v6(b: [u8; 16]) -> bool {
    let zeros = |from: usize, to: usize| b[from..to].iter().all(|&x| x == 0);
    // IPv4-mapped (::ffff:a.b.c.d) → áp luật IPv4 cho địa chỉ nhúng.
    if zeros(0, 10) && b[10] == 0xff && b[11] == 0xff {
        return blocked_v4(v4_at(&b, 12));
    }
    // NAT64 64:ff9b::/96 → luật IPv4 của địa chỉ nhúng; 64:ff9b:1::/48 (dùng nội bộ) → chặn.
    if b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b {
        return if zeros(4, 12) { blocked_v4(v4_at(&b, 12)) } else { true };
    }
    // Chỉ cho global unicast 2000::/3: chặn ::, ::1, ::/96, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64…
    if b[0] & 0xe0 != 0x20 {
        return true;
    }
    if b[0] == 0x20 && b[1] == 0x01 {
        // 2001::/23 (IETF/Teredo), 2001:db8::/32 (tài liệu)
        if b[2] < 0x02 || (b[2] == 0x0d && b[3] == 0xb8) {
            return true;
        }
    }
    if b[0] == 0x20 && b[1] == 0x02 {
        return blocked_v4([b[2], b[3], b[4], b[5]]); // 6to4 nhúng IPv4
    }
    b[0] == 0x3f && b[1] == 0xff && b[2] & 0xf0 == 0 // 3fff::/20 tài liệu
}

/// `true` nếu KHÔNG được kết nối tới địa chỉ này.
pub fn is_blocked_addr(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => blocked_v4(v4.octets()),
        IpAddr::V6(v6) => blocked_v6(v6.octets()),
    }
}

/// `true` nếu KHÔNG được kết nối tới địa chỉ dạng chuỗi này. Chuỗi không phải IP hợp lệ (kể cả IPv6 có zone `%eth0`,
/// IPv4 thiếu phần hay có số 0 đầu) ⇒ `true` (từ chối khi nghi ngờ).
pub fn is_blocked_ip(ip: &str) -> bool {
    parse_ip(ip).is_none_or(is_blocked_addr)
}

/// IP dạng chuẩn như `net.isIP` của Node: IPv4 bốn phần thập phân không số 0 đầu, IPv6 không zone.
fn parse_ip(s: &str) -> Option<IpAddr> {
    if let Ok(v4) = s.parse::<Ipv4Addr>() {
        return Some(IpAddr::V4(v4));
    }
    s.parse::<Ipv6Addr>().ok().map(IpAddr::V6)
}

/// URL đã qua bước kiểm cú pháp và chính sách.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedTarget {
    /// URL đã chuẩn hoá (WHATWG).
    pub url: Url,
    /// Tên máy không ngoặc `[]`, không dấu chấm cuối, chữ thường.
    pub hostname: String,
}

/// Kiểm cú pháp URL và chính sách giao thức/cổng/IP viết thẳng (CHƯA phân giải DNS) (`parseWebhookUrl`).
pub fn parse_target_url(raw: &str, policy: SsrfPolicy) -> Result<ValidatedTarget, SsrfBlocked> {
    let url = Url::parse(raw).map_err(|_| SsrfBlocked("URL không hợp lệ"))?;
    let permissive = policy.allow_private;
    if !(url.scheme() == "https" || (permissive && url.scheme() == "http")) {
        return Err(SsrfBlocked("Chỉ chấp nhận địa chỉ https://"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(SsrfBlocked("URL không được chứa tài khoản/mật khẩu"));
    }
    // `port()` là None khi cổng trống hoặc bằng cổng mặc định của giao thức (443), như `url.port === ''` của WHATWG.
    if !permissive && !matches!(url.port(), None | Some(8443)) {
        return Err(SsrfBlocked("Chỉ chấp nhận cổng 443 hoặc 8443"));
    }
    let host = url.host_str().unwrap_or("");
    let host = host.strip_prefix('[').unwrap_or(host);
    let host = host.strip_suffix(']').unwrap_or(host);
    let hostname = host.strip_suffix('.').unwrap_or(host).to_lowercase();
    if hostname.is_empty() {
        return Err(SsrfBlocked("URL thiếu tên miền"));
    }
    if !permissive && parse_ip(&hostname).is_some() && is_blocked_ip(&hostname) {
        return Err(SsrfBlocked("Địa chỉ IP nội bộ/không công cộng bị chặn"));
    }
    Ok(ValidatedTarget { url, hostname })
}

/// Chặn nếu BẤT KỲ địa chỉ nào không công cộng (kẻ tấn công trộn một IP nội bộ vào danh sách A).
pub fn assert_public_addresses(addrs: &[IpAddr], policy: SsrfPolicy) -> Result<(), SsrfBlocked> {
    if addrs.is_empty() {
        return Err(SsrfBlocked(UNREACHABLE_MSG));
    }
    if !policy.allow_private && addrs.iter().any(|&a| is_blocked_addr(a)) {
        return Err(SsrfBlocked(UNREACHABLE_MSG));
    }
    Ok(())
}

/// Future trả về của [`HostResolver::lookup`].
pub type LookupFuture<'a> = Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send + 'a>>;

/// Bộ phân giải tên miền (thay được trong test để giả DNS, kể cả DNS rebinding).
pub trait HostResolver: Send + Sync + 'static {
    /// Mọi địa chỉ của `host`.
    fn lookup<'a>(&'a self, host: &'a str) -> LookupFuture<'a>;
}

/// DNS của hệ điều hành (`getaddrinfo`, như `dns.lookup` của Node).
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolver;

impl HostResolver for SystemResolver {
    fn lookup<'a>(&'a self, host: &'a str) -> LookupFuture<'a> {
        Box::pin(async move { Ok(tokio::net::lookup_host((host, 0)).await?.map(|a| a.ip()).collect()) })
    }
}

/// Kiểm lúc TẠO/SỬA endpoint (và trước mỗi lần gửi, để báo lỗi sớm) (`assertSafeUrl`).
pub async fn assert_safe_url(
    raw: &str,
    policy: SsrfPolicy,
    resolver: &dyn HostResolver,
) -> Result<ValidatedTarget, SsrfBlocked> {
    let target = parse_target_url(raw, policy)?;
    if parse_ip(&target.hostname).is_none() {
        let addrs = resolver
            .lookup(&target.hostname)
            .await
            .map_err(|_| SsrfBlocked(UNREACHABLE_MSG))?;
        assert_public_addresses(&addrs, policy)?;
    }
    Ok(target)
}

/// Bộ phân giải cắm vào client `reqwest` (`createSafeLookup`): phân giải, kiểm, rồi trả đúng các địa chỉ đã kiểm.
/// Socket kết nối thẳng tới các địa chỉ này nên DNS rebinding (đổi đáp án giữa lúc kiểm và lúc nối) vô tác dụng.
pub struct SafeDnsResolver {
    policy: SsrfPolicy,
    inner: Arc<dyn HostResolver>,
}

impl SafeDnsResolver {
    /// Bộ phân giải an toàn trên `inner`.
    pub fn new(policy: SsrfPolicy, inner: Arc<dyn HostResolver>) -> Self {
        Self { policy, inner }
    }

    /// Phân giải và kiểm; lỗi là [`SsrfBlocked`].
    pub async fn resolve_checked(&self, host: &str) -> Result<Vec<IpAddr>, SsrfBlocked> {
        let addrs = self
            .inner
            .lookup(host)
            .await
            .map_err(|_| SsrfBlocked(UNREACHABLE_MSG))?;
        assert_public_addresses(&addrs, self.policy)?;
        Ok(addrs)
    }
}

impl reqwest::dns::Resolve for SafeDnsResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let policy = self.policy;
        let inner = Arc::clone(&self.inner);
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let checked = SafeDnsResolver { policy, inner }.resolve_checked(&host).await?;
            let addrs: reqwest::dns::Addrs = Box::new(checked.into_iter().map(|ip| SocketAddr::new(ip, 0)));
            Ok(addrs)
        })
    }
}

/// Client `reqwest` cho đích do người dùng nhập: phân giải qua [`SafeDnsResolver`], không theo chuyển hướng, không
/// dùng proxy của môi trường (proxy sẽ tự phân giải, bỏ qua bước kiểm), hết hạn kết nối sau `connect_timeout`.
pub fn safe_client(
    policy: SsrfPolicy,
    resolver: Arc<dyn HostResolver>,
    connect_timeout: Duration,
) -> reqwest::Result<reqwest::Client> {
    // reqwest dùng rustls không kèm provider (Cargo.toml gốc): cài `ring` nếu tiến trình chưa cài (lần sau là no-op).
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .dns_resolver(Arc::new(SafeDnsResolver::new(policy, resolver)))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(connect_timeout)
        .build()
}
