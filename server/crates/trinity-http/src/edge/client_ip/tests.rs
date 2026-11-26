//! Bảng ca chuyển từ `packages/rbac-nest/src/client-ip.spec.ts` (G16a): 5 giá trị `TRUSTED_PROXY` × peer × header.

use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::http::{HeaderMap, HeaderName, HeaderValue};

use super::*;

const CF_PEER: &str = "172.70.1.1"; // thuộc 172.64.0.0/13 (Cloudflare)
const PUBLIC_PEER: &str = "198.51.100.9";
const REAL: &str = "203.0.113.50";
const FAKE: &str = "203.0.113.108";
const GATEWAY: &str = "172.18.0.1";
const ROUTE_TABLE: &str =
    "Iface\tDestination\tGateway\tFlags\neth0\t00000000\t010012AC\t0003\neth0\t000012AC\t00000000\t0001\n";
const SECRET_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NOW: u64 = 1_800_000_000;

fn env(extra: &[(&str, &str)]) -> EnvMap {
    let mut m: EnvMap = [("INTERNAL_SERVICE_SECRET", SECRET_A), ("SERVICE_SECRET", SECRET_B)]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
    for (k, v) in extra {
        m.insert((*k).to_owned(), (*v).to_owned());
    }
    m
}

fn tp(v: Option<&str>) -> Vec<(&'static str, &str)> {
    v.map(|v| vec![("TRUSTED_PROXY", v)]).unwrap_or_default()
}

fn resolver(e: &EnvMap) -> ClientIpResolver {
    resolver_in(e, true)
}

fn resolver_in(e: &EnvMap, in_container: bool) -> ClientIpResolver {
    let probe = NetProbe::Fixed {
        route_table: Some(ROUTE_TABLE.to_owned()),
        in_container,
    };
    ClientIpResolver::from_env(e, probe)
        .expect("cấu hình hợp lệ")
        .with_clock(|| NOW * 1000)
}

fn hm(headers: &[(&str, String)]) -> HeaderMap {
    let mut h = HeaderMap::new();
    for (k, v) in headers {
        h.append(
            HeaderName::from_bytes(k.as_bytes()).unwrap(),
            HeaderValue::from_str(v).unwrap(),
        );
    }
    h
}

fn decide(r: &ClientIpResolver, peer: &str, headers: &[(&str, &str)]) -> Decision {
    let h = hm(&headers.iter().map(|(k, v)| (*k, (*v).to_owned())).collect::<Vec<_>>());
    r.determine(&Parts {
        headers: &h,
        peer: Some(peer.parse::<IpAddr>().unwrap()),
    })
}

fn ip_of(r: &ClientIpResolver, peer: &str, headers: &[(&str, &str)]) -> Option<String> {
    match decide(r, peer, headers) {
        Decision::Ok(c) => c.ip.map(|i| i.to_string()),
        Decision::Bad { error, .. } => panic!("không mong 400: {error}"),
    }
}

#[test]
fn normalize_ipv4_mapped_va_khong_phai_ip() {
    assert_eq!(normalize_ip("::ffff:127.0.0.1"), Some("127.0.0.1".parse().unwrap()));
    assert_eq!(
        normalize_ip(" ::FFFF:203.0.113.5 "),
        Some("203.0.113.5".parse().unwrap())
    );
    assert_eq!(normalize_ip("[2001:DB8::1]"), Some("2001:db8::1".parse().unwrap()));
    assert_eq!(normalize_ip("203.0.113.5, 1.2.3.4"), None);
    assert_eq!(normalize_ip("unknown"), None);
}

#[test]
fn cong_mac_dinh_doc_little_endian_va_chi_trong_container() {
    assert_eq!(parse_default_gateway(ROUTE_TABLE), Some(GATEWAY.parse().unwrap()));
    assert_eq!(parse_default_gateway("Iface\tDestination\tGateway\n"), None);
    // ngoài container: luật cổng mặc định không áp, peer trùng địa chỉ router vẫn là IP khách
    let r = resolver_in(&env(&tp(Some("none"))), false);
    assert_eq!(ip_of(&r, GATEWAY, &[]), Some(GATEWAY.to_owned()));
    let r = resolver(&env(&tp(Some("none"))));
    assert_eq!(ip_of(&r, GATEWAY, &[]), None);
}

#[test]
fn parse_trusted_proxy_nam_gia_tri() {
    assert_eq!(parse_trusted_proxy(None).unwrap(), TrustedProxy::None);
    assert_eq!(
        parse_trusted_proxy(Some("cloudflare")).unwrap(),
        TrustedProxy::Cloudflare
    );
    assert_eq!(
        parse_trusted_proxy(Some("cloudflare-tunnel")).unwrap(),
        TrustedProxy::CloudflareTunnel
    );
    let TrustedProxy::Cidr { entries, header } =
        parse_trusted_proxy(Some("cidr:127.0.0.1/32, 10.0.0.0/8;header=x-real-ip")).unwrap()
    else {
        panic!("phải là cidr")
    };
    assert_eq!(entries.len(), 2);
    assert_eq!(header, ForwardHeader::XRealIp);
    assert_eq!(
        parse_trusted_proxy(Some("cloudflare-behind:docker-gateway")).unwrap(),
        TrustedProxy::CloudflareBehind {
            entries: vec![ProxyEntry::DockerGateway]
        }
    );
}

#[test]
fn parse_trusted_proxy_sai_kem_bang_cach_trien_khai() {
    assert!(
        parse_trusted_proxy(Some("true"))
            .unwrap_err()
            .contains("cloudflare-behind:127.0.0.1/32")
    );
    assert!(parse_trusted_proxy(Some("cidr:")).unwrap_err().contains("trống"));
    assert!(
        parse_trusted_proxy(Some("cidr:300.1.1.1/8"))
            .unwrap_err()
            .contains("không phải IP")
    );
    assert!(
        parse_trusted_proxy(Some("cidr:127.0.0.1/32;header=cf-connecting-ip"))
            .unwrap_err()
            .contains("tuỳ chọn")
    );
}

/// Hàng bảng ca: (tên, TRUSTED_PROXY, peer, header, IP mong đợi — `None` = không tin được).
type Row = (
    &'static str,
    Option<&'static str>,
    &'static str,
    Vec<(&'static str, &'static str)>,
    Option<&'static str>,
);

fn rows() -> Vec<Row> {
    let xff_fake_real: &'static str = Box::leak(format!("{FAKE}, {REAL}").into_boxed_str());
    let xff_fake_cf: &'static str = Box::leak(format!("{FAKE}, {CF_PEER}").into_boxed_str());
    let forwarded: &'static str = Box::leak(format!("for={FAKE}").into_boxed_str());
    vec![
        // none
        (
            "none, peer công cộng, header giả mọi loại",
            None,
            PUBLIC_PEER,
            vec![
                ("x-real-ip", FAKE),
                ("x-forwarded-for", FAKE),
                ("cf-connecting-ip", FAKE),
                ("forwarded", forwarded),
            ],
            Some(PUBLIC_PEER),
        ),
        (
            "none, peer Cloudflare + cf-connecting-ip thật ⇒ vẫn IP peer",
            Some("none"),
            CF_PEER,
            vec![("cf-connecting-ip", REAL)],
            Some(CF_PEER),
        ),
        (
            "none, peer loopback (proxy chưa khai) ⇒ không tin được",
            Some("none"),
            "127.0.0.1",
            vec![("x-real-ip", REAL)],
            None,
        ),
        (
            "none, peer ::ffff:127.0.0.1 ⇒ không tin được",
            Some("none"),
            "::ffff:127.0.0.1",
            vec![],
            None,
        ),
        (
            "none, peer là cổng mặc định container ⇒ không tin được",
            Some("none"),
            GATEWAY,
            vec![("x-forwarded-for", REAL)],
            None,
        ),
        (
            "none, khách LAN tại chỗ là khách thật",
            Some("none"),
            "192.168.1.20",
            vec![("x-forwarded-for", FAKE)],
            Some("192.168.1.20"),
        ),
        (
            "none, khách LAN IPv6 ULA là khách thật",
            Some("none"),
            "fd00::5",
            vec![],
            Some("fd00::5"),
        ),
        // cloudflare
        (
            "cloudflare, peer trong dải CF + cf-connecting-ip",
            Some("cloudflare"),
            CF_PEER,
            vec![("cf-connecting-ip", REAL), ("x-real-ip", FAKE)],
            Some(REAL),
        ),
        (
            "cloudflare, peer IPv6 trong dải CF",
            Some("cloudflare"),
            "2606:4700::1",
            vec![("cf-connecting-ip", REAL)],
            Some(REAL),
        ),
        (
            "cloudflare, peer ngoài dải + cf-connecting-ip giả ⇒ IP peer",
            Some("cloudflare"),
            PUBLIC_PEER,
            vec![("cf-connecting-ip", FAKE)],
            Some(PUBLIC_PEER),
        ),
        (
            "cloudflare, peer trong dải nhưng thiếu header ⇒ không tin được",
            Some("cloudflare"),
            CF_PEER,
            vec![],
            None,
        ),
        (
            "cloudflare, peer là cổng mặc định ⇒ không tin được",
            Some("cloudflare"),
            GATEWAY,
            vec![("cf-connecting-ip", FAKE)],
            None,
        ),
        (
            "cloudflare, peer mạng riêng ngoài dải CF + header giả ⇒ IP peer",
            Some("cloudflare"),
            "10.1.2.3",
            vec![("cf-connecting-ip", FAKE)],
            Some("10.1.2.3"),
        ),
        // cloudflare-tunnel
        (
            "cloudflare-tunnel, cloudflared loopback + cf-connecting-ip",
            Some("cloudflare-tunnel"),
            "127.0.0.1",
            vec![("cf-connecting-ip", REAL)],
            Some(REAL),
        ),
        (
            "cloudflare-tunnel, thiếu header ⇒ không tin được",
            Some("cloudflare-tunnel"),
            "127.0.0.1",
            vec![("x-real-ip", FAKE)],
            None,
        ),
        (
            "cloudflare-tunnel, cf-connecting-ip là loopback ⇒ không tin được",
            Some("cloudflare-tunnel"),
            "127.0.0.1",
            vec![("cf-connecting-ip", "127.0.0.1")],
            None,
        ),
        // cidr
        (
            "cidr, phần tử PHẢI CÙNG của XFF (client chèn đầu bị bỏ)",
            Some("cidr:127.0.0.1/32"),
            "127.0.0.1",
            vec![("x-forwarded-for", xff_fake_real)],
            Some(REAL),
        ),
        (
            "cidr, Caddyfile mặc định + X-Real-IP giả ⇒ bị bỏ qua",
            Some("cidr:127.0.0.1/32"),
            "127.0.0.1",
            vec![("x-real-ip", FAKE), ("x-forwarded-for", REAL)],
            Some(REAL),
        ),
        (
            "cidr, peer ::ffff:127.0.0.1 khớp 127.0.0.1/32",
            Some("cidr:127.0.0.1/32"),
            "::ffff:127.0.0.1",
            vec![("x-forwarded-for", REAL)],
            Some(REAL),
        ),
        (
            "cidr, peer ngoài danh sách + header giả ⇒ IP peer",
            Some("cidr:127.0.0.1/32"),
            PUBLIC_PEER,
            vec![("x-forwarded-for", FAKE), ("x-real-ip", FAKE)],
            Some(PUBLIC_PEER),
        ),
        (
            "cidr, khách LAN ngoài danh sách + XFF giả ⇒ IP peer",
            Some("cidr:127.0.0.1/32"),
            "192.168.1.20",
            vec![("x-forwarded-for", FAKE)],
            Some("192.168.1.20"),
        ),
        (
            "cidr, peer mạng riêng TRONG danh sách ⇒ XFF",
            Some("cidr:10.0.0.0/8"),
            "10.0.0.7",
            vec![("x-forwarded-for", REAL)],
            Some(REAL),
        ),
        (
            "cidr, peer trong danh sách nhưng thiếu XFF ⇒ không tin được",
            Some("cidr:127.0.0.1/32"),
            "127.0.0.1",
            vec![("x-real-ip", REAL)],
            None,
        ),
        (
            "cidr ;header=x-real-ip, peer trong danh sách",
            Some("cidr:127.0.0.1/32;header=x-real-ip"),
            "127.0.0.1",
            vec![("x-real-ip", REAL), ("x-forwarded-for", FAKE)],
            Some(REAL),
        ),
        (
            "cidr ;header=x-real-ip, peer ngoài danh sách ⇒ IP peer",
            Some("cidr:127.0.0.1/32;header=x-real-ip"),
            PUBLIC_PEER,
            vec![("x-real-ip", FAKE)],
            Some(PUBLIC_PEER),
        ),
        (
            "cidr:docker-gateway, peer là cổng mặc định ⇒ XFF",
            Some("cidr:docker-gateway"),
            GATEWAY,
            vec![("x-forwarded-for", REAL)],
            Some(REAL),
        ),
        (
            "cidr ghi sai dải Docker ⇒ không tin được, không khoá",
            Some("cidr:172.30.0.0/16"),
            GATEWAY,
            vec![("x-forwarded-for", REAL)],
            None,
        ),
        // cloudflare-behind
        (
            "cloudflare-behind, hop do proxy ghi ∈ CF ⇒ cf-connecting-ip",
            Some("cloudflare-behind:127.0.0.1/32"),
            "127.0.0.1",
            vec![("x-forwarded-for", xff_fake_cf), ("cf-connecting-ip", REAL)],
            Some(REAL),
        ),
        (
            "cloudflare-behind, gửi thẳng proxy từ ngoài dải CF + header giả ⇒ hop",
            Some("cloudflare-behind:127.0.0.1/32"),
            "127.0.0.1",
            vec![("x-forwarded-for", PUBLIC_PEER), ("cf-connecting-ip", FAKE)],
            Some(PUBLIC_PEER),
        ),
        (
            "cloudflare-behind, peer ngoài cidr + header giả ⇒ IP peer",
            Some("cloudflare-behind:127.0.0.1/32"),
            PUBLIC_PEER,
            vec![("x-forwarded-for", CF_PEER), ("cf-connecting-ip", FAKE)],
            Some(PUBLIC_PEER),
        ),
        (
            "cloudflare-behind, hop ∈ CF nhưng thiếu cf-connecting-ip ⇒ không tin được",
            Some("cloudflare-behind:127.0.0.1/32"),
            "127.0.0.1",
            vec![("x-forwarded-for", CF_PEER)],
            None,
        ),
        // Rust sau Caddy/nginx cùng máy (K16): `cidr:127.0.0.1/32` cho IP thật, `none` thì không tin được
        (
            "Rust sau Caddy cùng máy, cidr:127.0.0.1/32 ⇒ IP thật",
            Some("cidr:127.0.0.1/32"),
            "127.0.0.1",
            vec![("x-forwarded-for", REAL)],
            Some(REAL),
        ),
        (
            "Rust sau Caddy cùng máy, none ⇒ IP không tin được",
            Some("none"),
            "127.0.0.1",
            vec![("x-forwarded-for", REAL)],
            None,
        ),
        // Cloudflare giả → Caddy → Rust (cloudflare-behind): Caddy ghi XFF = địa chỉ Cloudflare giả
        (
            "Cloudflare giả → Caddy → Rust, cloudflare-behind ⇒ cf-connecting-ip",
            Some("cloudflare-behind:127.0.0.1/32"),
            "127.0.0.1",
            vec![("x-forwarded-for", CF_PEER), ("cf-connecting-ip", REAL)],
            Some(REAL),
        ),
    ]
}

#[test]
fn bang_ca_trusted_proxy() {
    for (name, t, peer, headers, expected) in rows() {
        let r = resolver(&env(&tp(t)));
        assert_eq!(ip_of(&r, peer, &headers).as_deref(), expected, "ca: {name}");
    }
}

#[test]
fn nginx_cung_may_x_real_ip_va_cidr_sai_dai() {
    // nginx cùng máy gửi X-Real-IP: chỉ tin khi khai `;header=x-real-ip`; mặc định đọc XFF phải cùng.
    let r = resolver(&env(&tp(Some("cidr:127.0.0.1/32;header=x-real-ip"))));
    assert_eq!(
        ip_of(
            &r,
            "127.0.0.1",
            &[("x-real-ip", REAL), ("x-forwarded-for", &format!("{FAKE}, {REAL}"))]
        )
        .as_deref(),
        Some(REAL)
    );
    // cidr: ghi sai dải (peer thật 127.0.0.1 nằm ngoài 10.0.0.0/8) ⇒ peer là loopback ⇒ không tin được, không khoá
    let r = resolver(&env(&tp(Some("cidr:10.0.0.0/8"))));
    assert_eq!(ip_of(&r, "127.0.0.1", &[("x-forwarded-for", REAL)]), None);
}

#[test]
fn cloudflare_ip_ranges_ghi_de_danh_sach_mac_dinh() {
    let r = resolver(&env(&[
        ("TRUSTED_PROXY", "cloudflare"),
        ("CLOUDFLARE_IP_RANGES", "192.0.2.0/24"),
    ]));
    assert_eq!(
        ip_of(&r, "192.0.2.7", &[("cf-connecting-ip", REAL)]).as_deref(),
        Some(REAL)
    );
    assert_eq!(
        ip_of(&r, CF_PEER, &[("cf-connecting-ip", FAKE)]).as_deref(),
        Some(CF_PEER)
    );
}

#[test]
fn khong_tin_duoc_thi_khoa_toc_do_la_ip_peer() {
    let r = resolver(&env(&[]));
    let Decision::Ok(c) = decide(&r, "127.0.0.1", &[("x-real-ip", REAL)]) else {
        panic!()
    };
    assert_eq!((c.ip, c.rate_key.as_str()), (None, "127.0.0.1"));
}

#[test]
fn danh_sach_cloudflare_mac_dinh_co_ipv4_va_ipv6() {
    assert!(DEFAULT_CLOUDFLARE_IP_RANGES.iter().any(|r| r.contains(':')));
    assert!(DEFAULT_CLOUDFLARE_IP_RANGES.contains(&"172.64.0.0/13"));
    assert!(DEFAULT_CLOUDFLARE_IP_RANGES.iter().all(|r| IpNet::parse(r).is_some()));
}

fn signed(value: &str, secret: &str, ts: u64) -> Vec<(&'static str, String)> {
    vec![(CLIENT_IP_HEADER, sign_client_ip(value, secret, ts))]
}

fn decide_h(r: &ClientIpResolver, peer: &str, h: &[(&'static str, String)]) -> Decision {
    r.determine(&Parts {
        headers: &hm(h),
        peer: Some(peer.parse().unwrap()),
    })
}

#[test]
fn hkdf_va_chu_ky_khop_vector_node() {
    // Vector sinh bằng Node: hkdfSync('sha256', 'a'*64, '', 'trinity x-trinity-client-ip v1', 32) và HMAC trên "203.0.113.50\n1800000000".
    let key = derive_client_ip_key(SECRET_A);
    let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, include_str!("hkdf_vector.txt").trim());
    assert_eq!(
        sign_client_ip(REAL, SECRET_A, NOW),
        include_str!("sig_vector.txt").trim()
    );
}

#[test]
fn chu_ky_dung_dung_gia_tri_bo_qua_trusted_proxy_va_header_khac() {
    let r = resolver(&env(&tp(Some("cloudflare"))));
    let mut h = signed(REAL, SECRET_A, NOW);
    h.push(("x-real-ip", FAKE.to_owned()));
    h.push(("cf-connecting-ip", FAKE.to_owned()));
    let Decision::Ok(c) = decide_h(&r, "127.0.0.1", &h) else {
        panic!()
    };
    assert_eq!(
        c,
        ClientIp {
            ip: Some(REAL.parse().unwrap()),
            rate_key: REAL.to_owned(),
            untrusted_reason: None,
            source: Source::Signed
        }
    );
}

#[test]
fn ky_bang_service_secret_va_api_chi_co_mot_bi_mat() {
    let r = resolver(&env(&[]));
    assert!(
        matches!(decide_h(&r, "10.0.0.5", &signed(REAL, SECRET_B, NOW)), Decision::Ok(c) if c.ip == Some(REAL.parse().unwrap()))
    );
    let only_b: EnvMap = [("SERVICE_SECRET".to_owned(), SECRET_B.to_owned())]
        .into_iter()
        .collect();
    let r = resolver(&only_b);
    assert!(
        matches!(decide_h(&r, "10.0.0.5", &signed(REAL, SECRET_B, NOW)), Decision::Ok(c) if c.ip == Some(REAL.parse().unwrap()))
    );
}

#[test]
fn dau_untrusted_khong_chu_ky() {
    let r = resolver(&env(&[]));
    let h = [(CLIENT_IP_HEADER, UNTRUSTED_CLIENT_IP.to_owned())];
    let Decision::Ok(c) = decide_h(&r, "127.0.0.1", &h) else {
        panic!()
    };
    assert_eq!((c.ip, c.rate_key.as_str()), (None, "127.0.0.1"));
    let r = resolver(&env(&tp(Some("cidr:10.0.0.0/8"))));
    let Decision::Ok(c) = decide_h(&r, "10.0.0.7", &h) else {
        panic!()
    };
    assert_eq!(c.ip, None);
    // gửi thẳng từ ngoài: bỏ qua header, IP từ peer (không tắt được kiểm Wi-Fi/chấm công)
    let r = resolver(&env(&[]));
    assert_eq!(
        ip_of(&r, PUBLIC_PEER, &[(CLIENT_IP_HEADER, UNTRUSTED_CLIENT_IP)]).as_deref(),
        Some(PUBLIC_PEER)
    );
    let r = resolver(&env(&tp(Some("cidr:127.0.0.1/32"))));
    assert_eq!(
        ip_of(&r, "192.168.1.20", &[(CLIENT_IP_HEADER, UNTRUSTED_CLIENT_IP)]).as_deref(),
        Some("192.168.1.20")
    );
}

#[test]
fn dau_khong_tin_duoc_co_chu_ky() {
    let r = resolver(&env(&[]));
    let Decision::Ok(c) = decide_h(&r, "10.0.0.5", &signed(UNTRUSTED_CLIENT_IP, SECRET_A, NOW)) else {
        panic!()
    };
    assert_eq!(
        (c.ip, c.rate_key.as_str(), c.source),
        (None, "10.0.0.5", Source::Signed)
    );
}

type BadCase = (&'static str, Vec<(&'static str, String)>, &'static str);

#[test]
fn chu_ky_sai_het_han_sai_dinh_dang_deu_400() {
    let r = resolver(&env(&[]));
    let cases: Vec<BadCase> = vec![
        ("bí mật khác", signed(REAL, &"c".repeat(64), NOW), "không hợp lệ"),
        (
            "giá trị bị sửa sau khi ký",
            vec![(
                CLIENT_IP_HEADER,
                sign_client_ip(REAL, SECRET_A, NOW).replace(REAL, FAKE),
            )],
            "không hợp lệ",
        ),
        ("quá hạn 61 giây", signed(REAL, SECRET_A, NOW - 61), "hết hạn"),
        ("phát lại sau 120 giây", signed(REAL, SECRET_A, NOW - 120), "hết hạn"),
        ("tương lai quá 60 giây", signed(REAL, SECRET_A, NOW + 61), "hết hạn"),
        ("sai định dạng", vec![(CLIENT_IP_HEADER, FAKE.to_owned())], "định dạng"),
        ("giá trị không phải IP", signed("not-an-ip", SECRET_A, NOW), "định dạng"),
    ];
    for (name, h, msg) in cases {
        match decide_h(&r, "127.0.0.1", &h) {
            Decision::Bad { error, .. } => assert!(error.contains(msg), "ca {name}: {error}"),
            Decision::Ok(_) => panic!("ca {name}: phải 400"),
        }
    }
}

#[test]
fn dung_mep_60_giay_van_hop_le_va_thieu_bi_mat_la_400() {
    let r = resolver(&env(&[]));
    assert!(
        matches!(decide_h(&r, "127.0.0.1", &signed(REAL, SECRET_A, NOW - 60)), Decision::Ok(c) if c.ip == Some(REAL.parse().unwrap()))
    );
    let none = resolver(&EnvMap::new());
    assert!(matches!(
        decide_h(&none, "127.0.0.1", &signed(REAL, SECRET_A, NOW)),
        Decision::Bad { .. }
    ));
}

#[test]
fn ip_co_chu_ky_la_loopback_van_khong_tin_duoc() {
    let r = resolver(&env(&[]));
    assert!(matches!(decide_h(&r, "10.0.0.5", &signed("127.0.0.1", SECRET_A, NOW)), Decision::Ok(c) if c.ip.is_none()));
}

#[test]
fn dai_canh_bao_quan_tri_khong_nhap_nhay_va_tu_tat_sau_24_gio() {
    let clock = Arc::new(AtomicU64::new(NOW * 1000));
    let c2 = clock.clone();
    let probe = NetProbe::Fixed {
        route_table: Some(ROUTE_TABLE.to_owned()),
        in_container: true,
    };
    let r = ClientIpResolver::from_env(&env(&[]), probe)
        .unwrap()
        .with_clock(move || c2.load(Ordering::Relaxed));
    let resolve = |peer: &str, h: &[(&str, &str)]| {
        let h = hm(&h.iter().map(|(k, v)| (*k, (*v).to_owned())).collect::<Vec<_>>());
        r.resolve(
            None,
            &Parts {
                headers: &h,
                peer: Some(peer.parse().unwrap()),
            },
        )
    };
    assert!(r.warning().is_none());
    resolve(PUBLIC_PEER, &[]);
    assert!(r.warning().is_none());
    resolve("127.0.0.1", &[("x-real-ip", REAL)]);
    assert!(r.warning().unwrap().contains("TRUSTED_PROXY"));
    resolve(PUBLIC_PEER, &[]);
    assert!(
        r.warning().unwrap().contains("loopback"),
        "request tin được xen giữa không tắt cảnh báo"
    );
    clock.store((NOW + 25 * 3600) * 1000, Ordering::Relaxed);
    assert!(r.warning().is_none());
}

#[test]
fn khoi_dong_co_cu_khong_kem_trusted_proxy_thi_khong_len() {
    for flag in LEGACY_TRUST_FLAGS {
        let p = startup_problems(&env(&[(flag, "true")]));
        assert_eq!(p.len(), 1, "{flag}");
        assert!(p[0].contains(flag) && p[0].contains("cidr:127.0.0.1/32") && p[0].contains("cloudflare-tunnel"));
    }
}

#[test]
fn khoi_dong_co_cu_gia_tri_khac_hoac_da_co_trusted_proxy_thi_chi_canh_bao() {
    assert!(startup_problems(&env(&[("ATTENDANCE_TRUST_CF_IP", "false")])).is_empty());
    assert!(
        startup_problems(&env(&[
            ("ATTENDANCE_TRUST_CF_IP", "1"),
            ("LOGIN_WIFI_TRUST_CF_IP", "yes")
        ]))
        .is_empty()
    );
    assert!(startup_warnings(&env(&[("ATTENDANCE_TRUST_CF_IP", "1")]))[0].contains("ATTENDANCE_TRUST_CF_IP"));
    assert!(startup_warnings(&env(&[])).is_empty());
    assert!(
        startup_problems(&env(&[
            ("ATTENDANCE_TRUST_CF_IP", "true"),
            ("TRUSTED_PROXY", "cloudflare")
        ]))
        .is_empty()
    );
}

#[test]
fn khoi_dong_cau_hinh_sai_thi_khong_len() {
    assert_eq!(startup_problems(&env(&[("TRUSTED_PROXY", "yes")])).len(), 1);
    assert_eq!(
        startup_problems(&env(&[("CLOUDFLARE_IP_RANGES", "1.2.3.4/99")])).len(),
        1
    );
    assert!(
        startup_problems(&env(&[("CLOUDFLARE_IP_RANGES", "192.0.2.0/24, docker-gateway")]))[0]
            .contains("docker-gateway")
    );
}

#[test]
fn cloudflare_tunnel_chi_nghe_loopback() {
    let e = env(&[("TRUSTED_PROXY", "cloudflare-tunnel")]);
    for addr in ["::", "0.0.0.0", "172.18.0.3"] {
        assert!(
            tunnel_listen_problem(Some(addr), &e)
                .unwrap()
                .contains("không phải loopback"),
            "{addr}"
        );
    }
    assert!(tunnel_listen_problem(Some("127.0.0.1"), &e).is_none());
    assert!(tunnel_listen_problem(Some("::1"), &e).is_none());
    assert!(tunnel_listen_problem(Some("0.0.0.0"), &env(&[("TRUSTED_PROXY", "none")])).is_none());
}

#[test]
fn header_ip_khong_phai_ascii_la_400_va_localhost_la_loopback() {
    let r = resolver(&env(&[]));
    let mut h = HeaderMap::new();
    h.insert("x-forwarded-for", HeaderValue::from_bytes(&[0xE9, b'1']).unwrap());
    let d = r.determine(&Parts {
        headers: &h,
        peer: Some("198.51.100.9".parse().unwrap()),
    });
    assert!(matches!(d, Decision::Bad { .. }));
    let e = env(&[("TRUSTED_PROXY", "cloudflare-tunnel")]);
    assert!(tunnel_listen_problem(Some("localhost"), &e).is_none());
}

#[test]
fn log_once_khoa_theo_loai_va_bi_chan() {
    let r = resolver(&env(&[]));
    for i in 0..500u32 {
        let h = HeaderMap::new();
        r.resolve(
            None,
            &Parts {
                headers: &h,
                peer: Some(format!("127.0.{}.{}", i / 250, i % 250 + 1).parse().unwrap()),
            },
        );
    }
    assert!(r.lock().logged.len() <= 1);
}
