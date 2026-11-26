//! Chuyển từ `services/crm/src/integrations/webhooks/__tests__/ssrf-guard.spec.ts`.

use std::io;
use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use trinity_http::outbound::ssrf::{
    HostResolver, LookupFuture, SafeDnsResolver, SsrfPolicy, UNREACHABLE_MSG, assert_safe_url, is_blocked_ip,
    parse_target_url,
};

const PROD: SsrfPolicy = SsrfPolicy { allow_private: false };
const TEST_OPEN: SsrfPolicy = SsrfPolicy { allow_private: true };

/// Resolver giả: trả lần lượt từng đáp án trong `answers` (đáp án cuối lặp lại); `None` là lỗi DNS.
struct Fake {
    answers: Vec<Option<Vec<&'static str>>>,
    calls: AtomicUsize,
}

impl Fake {
    fn new(answers: Vec<Option<Vec<&'static str>>>) -> Arc<Self> {
        Arc::new(Self {
            answers,
            calls: AtomicUsize::new(0),
        })
    }
    fn one(addrs: &[&'static str]) -> Arc<Self> {
        Self::new(vec![Some(addrs.to_vec())])
    }
}

impl HostResolver for Fake {
    fn lookup<'a>(&'a self, _host: &'a str) -> LookupFuture<'a> {
        let i = self.calls.fetch_add(1, Ordering::SeqCst).min(self.answers.len() - 1);
        let answer = self.answers[i].clone();
        Box::pin(async move {
            match answer {
                Some(a) => Ok(a.iter().map(|s| s.parse::<IpAddr>().expect("ip")).collect()),
                None => Err(io::Error::other("ENOTFOUND")),
            }
        })
    }
}

#[test]
fn chan_ipv4() {
    let blocked = [
        "127.0.0.1",
        "127.255.255.254",
        "10.0.0.1",
        "10.255.255.255",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",
        "169.254.0.1",
        "100.64.0.1",
        "100.127.255.255",
        "0.0.0.0",
        "0.1.2.3",
        "224.0.0.1",
        "255.255.255.255",
        "192.0.0.5",
        "192.0.2.1",
        "198.18.0.1",
        "198.19.255.255",
        "198.51.100.7",
        "203.0.113.9",
        "240.0.0.1",
    ];
    for ip in blocked {
        assert!(is_blocked_ip(ip), "phải chặn {ip}");
    }
    let open = [
        "8.8.8.8",
        "1.1.1.1",
        "172.15.255.255",
        "172.32.0.1",
        "100.63.255.255",
        "100.128.0.1",
        "11.0.0.1",
        "193.168.0.1",
        "203.0.114.1",
        "126.255.255.255",
    ];
    for ip in open {
        assert!(!is_blocked_ip(ip), "phải cho {ip}");
    }
}

#[test]
fn chan_ipv6() {
    let blocked = [
        "::1",
        "::",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "febf::1",
        "fec0::1",
        "ff02::1",
        "::ffff:127.0.0.1",
        "::ffff:7f00:1",
        "::ffff:10.0.0.1",
        "::ffff:a00:1",
        "::ffff:169.254.169.254",
        "::ffff:c0a8:101",
        "64:ff9b::7f00:1",
        "64:ff9b::a9fe:a9fe",
        "64:ff9b:1::1",
        "2002:7f00:1::",
        "2002:a9fe:a9fe::1",
        "2001:db8::1",
        "2001::1",
        "2001:1::1",
        "100::1",
        "::127.0.0.1",
        "0:0:0:0:0:0:0:1",
        "fe80::1%eth0",
        "garbage",
        "",
        "1.2.3",
        "2130706433",
        // thêm: IPv4 có số 0 đầu (Node `isIP` cũng không nhận) và 3fff::/20
        "0177.0.0.1",
        "3fff::1",
    ];
    for ip in blocked {
        assert!(is_blocked_ip(ip), "phải chặn {ip:?}");
    }
    let open = [
        "2606:4700:4700::1111",
        "2001:4860:4860::8888",
        "2a00:1450:4001:81b::200e",
        "64:ff9b::808:808",
        "::ffff:8.8.8.8",
    ];
    for ip in open {
        assert!(!is_blocked_ip(ip), "phải cho {ip}");
    }
}

fn blocked(url: &str, policy: SsrfPolicy) -> String {
    parse_target_url(url, policy).expect_err(url).to_string()
}

#[test]
fn chi_https_o_production() {
    for u in [
        "http://example.com/x",
        "ftp://example.com/x",
        "file:///etc/passwd",
        "gopher://example.com",
    ] {
        assert_eq!(blocked(u, PROD), "Chỉ chấp nhận địa chỉ https://", "{u}");
    }
    assert_eq!(
        parse_target_url("https://example.com/hook?x=1", PROD)
            .expect("ok")
            .hostname,
        "example.com"
    );
    assert_eq!(blocked("not a url", PROD), "URL không hợp lệ");
}

#[test]
fn chan_tai_khoan_va_cong_la() {
    assert!(blocked("https://user:pw@example.com/", PROD).contains("tài khoản"));
    assert!(blocked("https://example.com:5432/", PROD).contains("cổng"));
    assert!(blocked("https://example.com:4000/", PROD).contains("cổng"));
    assert!(parse_target_url("https://example.com:8443/", PROD).is_ok());
    assert!(parse_target_url("https://example.com:443/", PROD).is_ok());
}

#[test]
fn chan_ip_viet_thang_va_dang_lach() {
    let urls = [
        "https://127.0.0.1/",
        "https://0.0.0.0/",
        "https://[::1]/",
        "https://10.1.2.3/",
        "https://169.254.169.254/latest/meta-data",
        // Dạng IP lách: WHATWG URL chuẩn hoá về a.b.c.d trước khi kiểm.
        "https://2130706433/",
        "https://0x7f000001/",
        "https://0x7f.1/",
        "https://017700000001/",
        "https://127.1/",
        "https://0/",
        "https://0177.0.0.1/",
        "https://[::ffff:127.0.0.1]/",
        "https://[::ffff:7f00:1]/",
        "https://[0:0:0:0:0:ffff:7f00:1]/",
        "https://[fd00::1]/",
        "https://[fe80::1]/",
        "https://100.64.0.1/",
        "https://192.168.0.1/",
        "https://[64:ff9b::7f00:1]/",
        "https://3232235521/",
        "https://127.0.0.1./",
    ];
    for u in urls {
        assert!(parse_target_url(u, PROD).is_err(), "phải chặn {u}");
    }
}

#[test]
fn ip_cong_cong_viet_thang_qua_buoc_cu_phap() {
    assert_eq!(
        parse_target_url("https://8.8.8.8/h", PROD).expect("ok").hostname,
        "8.8.8.8"
    );
    assert_eq!(
        parse_target_url("https://[2606:4700:4700::1111]/h", PROD)
            .expect("ok")
            .hostname,
        "2606:4700:4700::1111"
    );
    assert_eq!(
        parse_target_url("https://Example.COM./h", PROD).expect("ok").hostname,
        "example.com"
    );
}

#[test]
fn co_mo_chi_co_tac_dung_khi_test_hoac_dev() {
    let env = |pairs: &'static [(&'static str, &'static str)]| {
        SsrfPolicy::from_env(move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned()))
    };
    assert!(
        !env(&[
            ("NODE_ENV", "production"),
            ("INTEGRATIONS_ALLOW_PRIVATE_TARGETS", "true")
        ])
        .allow_private
    );
    assert!(!env(&[("INTEGRATIONS_ALLOW_PRIVATE_TARGETS", "true")]).allow_private); // thiếu NODE_ENV = production
    assert!(!env(&[("NODE_ENV", "staging"), ("INTEGRATIONS_ALLOW_PRIVATE_TARGETS", "1")]).allow_private);
    assert!(!env(&[("NODE_ENV", "test")]).allow_private); // thiếu cờ tường minh
    assert!(env(&[("NODE_ENV", "test"), ("INTEGRATIONS_ALLOW_PRIVATE_TARGETS", " TRUE ")]).allow_private);
    assert!(env(&[("NODE_ENV", "development"), ("INTEGRATIONS_ALLOW_PRIVATE_TARGETS", "1")]).allow_private);
    assert!(parse_target_url("http://127.0.0.1:8080/x", PROD).is_err());
    assert_eq!(
        parse_target_url("http://127.0.0.1:8080/x", TEST_OPEN)
            .expect("ok")
            .hostname,
        "127.0.0.1"
    );
}

#[tokio::test]
async fn ten_mien_phan_giai_ve_ip_noi_bo_bi_chan() {
    for addrs in [&["127.0.0.1"][..], &["169.254.169.254"], &["::1"], &["::ffff:10.0.0.5"]] {
        let e = assert_safe_url("https://evil.example.com/", PROD, Fake::one(addrs).as_ref())
            .await
            .expect_err("chặn");
        assert_eq!(e.to_string(), UNREACHABLE_MSG);
    }
    // BẤT KỲ địa chỉ nào nội bộ trong danh sách là đủ để chặn.
    assert!(
        assert_safe_url(
            "https://mix.example.com/",
            PROD,
            Fake::one(&["8.8.8.8", "10.0.0.1"]).as_ref()
        )
        .await
        .is_err()
    );
    // DNS lỗi / rỗng → từ chối, cùng một câu.
    let e = assert_safe_url("https://nx.example.com/", PROD, Fake::new(vec![None]).as_ref())
        .await
        .expect_err("lỗi DNS");
    assert_eq!(e.to_string(), UNREACHABLE_MSG);
    assert!(
        assert_safe_url("https://nx.example.com/", PROD, Fake::one(&[]).as_ref())
            .await
            .is_err()
    );
    // IP công cộng → qua.
    let t = assert_safe_url("https://ok.example.com/h", PROD, Fake::one(&["93.184.216.34"]).as_ref())
        .await
        .expect("qua");
    assert_eq!(t.hostname, "ok.example.com");
    assert!(
        assert_safe_url("https://localhost/", PROD, Fake::one(&["127.0.0.1"]).as_ref())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn dns_rebinding_bi_chan_o_buoc_phan_giai_luc_ket_noi() {
    // Lần 1 (lúc tạo endpoint) sạch, lần 2 (lúc client nối socket) là 127.0.0.1.
    let fake = Fake::new(vec![Some(vec!["93.184.216.34"]), Some(vec!["127.0.0.1"])]);
    assert!(
        assert_safe_url("https://rebind.example.com/", PROD, fake.as_ref())
            .await
            .is_ok()
    );
    let safe = SafeDnsResolver::new(PROD, fake.clone());
    assert_eq!(
        safe.resolve_checked("rebind.example.com")
            .await
            .expect_err("chặn")
            .to_string(),
        UNREACHABLE_MSG
    );
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn tra_dung_dia_chi_da_kiem_va_chan_ca_danh_sach_lan() {
    let safe = SafeDnsResolver::new(PROD, Fake::one(&["93.184.216.34", "2606:2800:220:1::1"]));
    let got = safe.resolve_checked("ok.example.com").await.expect("qua");
    assert_eq!(
        got,
        [
            "93.184.216.34".parse::<IpAddr>().expect("ip"),
            "2606:2800:220:1::1".parse().expect("ip")
        ]
    );
    let mixed = SafeDnsResolver::new(PROD, Fake::one(&["8.8.8.8", "192.168.0.9"]));
    assert!(mixed.resolve_checked("mix.example.com").await.is_err());
}
