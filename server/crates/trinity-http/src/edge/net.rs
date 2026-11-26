//! Địa chỉ IP và dải CIDR cho luật `TRUSTED_PROXY` (docs/rust/PLAN.md mục 4.13). Không phụ thuộc crate ngoài.

use std::net::{IpAddr, Ipv4Addr};

/// Chuẩn hoá một địa chỉ: bỏ khoảng trắng, `[...]`, đổi IPv4-mapped `::ffff:a.b.c.d` về `a.b.c.d`. Không phải IP ⇒ `None`.
/// Trùng `normalizeIp` của `packages/rbac-nest/src/client-ip.ts`.
pub fn normalize_ip(raw: &str) -> Option<IpAddr> {
    let mut s = raw.trim();
    if let Some(inner) = s.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
        s = inner;
    }
    let ip: IpAddr = s.parse().ok()?;
    Some(canonical(ip))
}

/// Đổi IPv4-mapped IPv6 về IPv4 (so khớp dải luôn trên dạng chuẩn hoá).
pub fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 => v4,
    }
}

/// `::1`, `127.x.x.x`, `0.0.0.0`, `::`.
pub fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.octets()[0] == 127 || v4.is_unspecified(),
        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
    }
}

/// Một dải CIDR (hoặc một địa chỉ = `/32`, `/128`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IpNet {
    addr: IpAddr,
    prefix: u8,
}

impl IpNet {
    /// `a.b.c.d`, `a.b.c.d/n`, `x::y/n`. Sai cú pháp hoặc `n` quá lớn ⇒ `None`.
    pub fn parse(raw: &str) -> Option<IpNet> {
        let mut it = raw.trim().split('/');
        let addr = normalize_ip(it.next()?)?;
        let max: u8 = if addr.is_ipv6() { 128 } else { 32 };
        let prefix = match it.next() {
            None => max,
            Some(b) if !b.is_empty() && b.len() <= 3 && b.bytes().all(|c| c.is_ascii_digit()) => b.parse().ok()?,
            Some(_) => return None,
        };
        if it.next().is_some() || prefix > max {
            return None;
        }
        Some(IpNet { addr, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, canonical(ip)) {
            (IpAddr::V4(n), IpAddr::V4(i)) => {
                masked_eq(u128::from(u32::from(n)), u128::from(u32::from(i)), 32, self.prefix)
            }
            (IpAddr::V6(n), IpAddr::V6(i)) => masked_eq(u128::from(n), u128::from(i), 128, self.prefix),
            _ => false,
        }
    }
}

fn masked_eq(a: u128, b: u128, bits: u32, prefix: u8) -> bool {
    let host = bits - u32::from(prefix);
    if host >= 128 {
        return true;
    }
    (a >> host) == (b >> host)
}

/// Đọc cổng mặc định (tuyến `0.0.0.0/0`) từ nội dung `/proc/net/route`. Địa chỉ ghi little-endian: `010012AC` = 172.18.0.1.
pub fn parse_default_gateway(route_table: &str) -> Option<IpAddr> {
    for line in route_table.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 3
            || cols[1] != "00000000"
            || cols[2].len() != 8
            || !cols[2].bytes().all(|c| c.is_ascii_hexdigit())
        {
            continue;
        }
        let b = |i: usize| u8::from_str_radix(&cols[2][i..i + 2], 16).ok();
        let ip = Ipv4Addr::new(b(6)?, b(4)?, b(2)?, b(0)?);
        if !ip.is_unspecified() {
            return Some(IpAddr::V4(ip));
        }
    }
    None
}
