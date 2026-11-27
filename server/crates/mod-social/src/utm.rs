//! Gắn UTM vào liên kết trong bài đăng (`social-utm.ts`). Chỉ chạy lúc đăng/xem trước (nội dung lưu trong bài vẫn sạch); cấu hình
//! lưu ở `options.utm` của từng kênh.

use mod_facebook::config::form_encode;
use serde_json::{Map, Value};

const MAX_LEN: usize = 100;
/// Liên kết dài hơn thế (đơn vị UTF-16) thì không gắn (chặn chuỗi bất thường làm chậm).
const MAX_URL: usize = 2048;
const UNSAFE: &str = "&#=?%/\\";
/// Dấu câu / dấu markdown cuối câu luôn không thuộc liên kết (vd `**https://shop.vn**`, `` `https://x.vn` ``).
const TRAILING: &str = ".,;:!?'\"”’…>*~`|。，、；：！？）】」";

/// Cấu hình UTM đã chuẩn hoá của một kênh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UtmInput {
    pub campaign: String,
    pub content: Option<String>,
}

/// `\s` của JavaScript (cũng là tập của `String.prototype.trim`).
pub fn is_js_space(c: char) -> bool {
    // Khác `char::is_whitespace`: JS tính BOM (U+FEFF) là khoảng trắng và không tính U+0085.
    (c.is_whitespace() && c != '\u{0085}') || c == '\u{FEFF}'
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `String.length` của JavaScript.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn slug(v: &str, label: &str) -> Result<String, String> {
    // `v.trim().replace(/\s+/g, '-')`.
    let mut s = String::new();
    let mut in_space = false;
    for c in js_trim(v).chars() {
        if is_js_space(c) {
            if !in_space {
                s.push('-');
            }
            in_space = true;
        } else {
            s.push(c);
            in_space = false;
        }
    }
    if s.is_empty() {
        return Err(format!("UTM: {label} không được để trống."));
    }
    if utf16_len(&s) > MAX_LEN {
        return Err(format!("UTM: {label} tối đa {MAX_LEN} ký tự."));
    }
    if s.contains(|c: char| UNSAFE.contains(c)) {
        return Err(format!("UTM: {label} không được chứa các ký tự & # = ? % /."));
    }
    Ok(s)
}

/// Chuẩn hoá cấu hình UTM người dùng gửi: vắng/`null` ⇒ `None`; sai ⇒ câu lỗi tiếng Việt (`normalizeUtm`).
pub fn normalize_utm(raw: Option<&Value>) -> Result<Option<UtmInput>, String> {
    let r = match raw {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(o)) => o,
        Some(_) => return Err("UTM: định dạng không hợp lệ.".to_owned()),
    };
    let Some(Value::String(campaign)) = r.get("campaign") else {
        return Err("UTM: cần chiến dịch (campaign) 1–100 ký tự.".to_owned());
    };
    let campaign = slug(campaign, "tên chiến dịch (campaign)")?;
    let content = match r.get("content") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::String(s)) => match js_trim(s) {
            "" => None,
            c => Some(slug(c, "utm_content")?),
        },
        Some(_) => return Err("UTM: utm_content phải là chữ.".to_owned()),
    };
    Ok(Some(UtmInput { campaign, content }))
}

/// Bộ tham số cho một mạng: `utm_source` = mạng, `utm_medium` = social (`utmParamsFor`).
pub fn utm_params_for(network: &str, utm: &UtmInput) -> Vec<(String, String)> {
    let mut p = vec![
        ("utm_source".to_owned(), network.to_owned()),
        ("utm_medium".to_owned(), "social".to_owned()),
        ("utm_campaign".to_owned(), utm.campaign.clone()),
    ];
    if let Some(c) = &utm.content {
        p.push(("utm_content".to_owned(), c.clone()));
    }
    p
}

fn closer_of(c: char) -> Option<char> {
    match c {
        ')' => Some('('),
        ']' => Some('['),
        '}' => Some('{'),
        _ => None,
    }
}

fn count_of(chars: &[char], target: char) -> usize {
    chars.iter().filter(|c| **c == target).count()
}

/// Cắt dấu câu đuôi không thuộc liên kết (ngoặc đóng chỉ giữ khi có ngoặc mở tương ứng trong liên kết).
fn trim_tail(chars: &[char]) -> usize {
    let mut end = chars.len();
    let mut closers_dropped = [0_usize; 3];
    while end > 0 {
        let last = chars[end - 1];
        if TRAILING.contains(last) {
            end -= 1;
            continue;
        }
        let Some(open) = closer_of(last) else { break };
        let slot = match last {
            ')' => 0,
            ']' => 1,
            _ => 2,
        };
        // Số ngoặc đóng còn lại (chưa bị cắt) so với số ngoặc mở.
        let closing_left = count_of(chars, last) - closers_dropped[slot];
        if closing_left > count_of(chars, open) {
            closers_dropped[slot] += 1;
            end -= 1;
        } else {
            break;
        }
    }
    end
}

/// Khoá (đã giải mã %XX và `+`) của một tham số query.
fn decode_key(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| char::from(b).to_digit(16);
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() && hex(bytes[i + 1]).is_some() && hex(bytes[i + 2]).is_some() => {
                let hi = hex(bytes[i + 1]).unwrap_or(0);
                let lo = hex(bytes[i + 2]).unwrap_or(0);
                out.push(u8::try_from(hi * 16 + lo).unwrap_or(0));
                i += 2;
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `new URL(url)` thành công với http(s): có host không rỗng.
fn is_valid_http_url(url: &str) -> bool {
    let rest = match url.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") => rest,
        _ => return false,
    };
    let authority = rest.split(['/', '?', '#', '\\']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or("");
    let host = match host_port.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => host_port.split(':').next().unwrap_or(""),
    };
    !host.is_empty() && !host.contains(char::is_whitespace)
}

/// Gắn tham số vào một liên kết; liên kết không đọc được, không phải http(s) hay đã có `utm_*` thì giữ nguyên.
fn tag(url: &str, params: &[(String, String)]) -> String {
    if !is_valid_http_url(url) {
        return url.to_owned();
    }
    let (base, hash) = match url.find('#') {
        Some(h) => (&url[..h], &url[h..]),
        None => (url, ""),
    };
    if let Some((_, query)) = base.split_once('?') {
        let has_utm = query
            .split('&')
            .map(|kv| kv.split('=').next().unwrap_or(""))
            .any(|k| decode_key(k).to_lowercase().starts_with("utm_"));
        if has_utm {
            return url.to_owned();
        }
    }
    let sep = if !base.contains('?') {
        "?"
    } else if base.ends_with('?') || base.ends_with('&') {
        ""
    } else {
        "&"
    };
    format!("{base}{sep}{}{hash}", form_encode(params))
}

/// Độ dài của tiền tố `https?://` nếu `chars[i..]` bắt đầu bằng nó (không phân biệt hoa thường).
fn scheme_len(chars: &[char], i: usize) -> Option<usize> {
    let lower = |k: usize| chars.get(i + k).map(|c| c.to_ascii_lowercase());
    if lower(0) != Some('h') || lower(1) != Some('t') || lower(2) != Some('t') || lower(3) != Some('p') {
        return None;
    }
    let n = if lower(4) == Some('s') { 5 } else { 4 };
    if lower(n) == Some(':') && lower(n + 1) == Some('/') && lower(n + 2) == Some('/') {
        Some(n + 3)
    } else {
        None
    }
}

fn is_url_char(c: char) -> bool {
    !is_js_space(c) && c != '<' && c != '>' && c != '"'
}

/// Độ dài (số ký tự) của liên kết `https?://[^\s<>"]+` bắt đầu tại `i`; không có liên kết ⇒ `None`.
fn link_at(chars: &[char], i: usize) -> Option<usize> {
    let head = scheme_len(chars, i)?;
    let mut body = 0;
    while chars.get(i + head + body).is_some_and(|c| is_url_char(*c)) {
        body += 1;
    }
    (body > 0).then_some(head + body)
}

/// Thêm tham số UTM vào mọi liên kết http(s) chưa có tham số `utm_*`. Gọi hai lần cho cùng kết quả (`applyUtm`).
pub fn apply_utm(text: &str, params: &[(String, String)]) -> String {
    if text.is_empty() || params.is_empty() {
        return text.to_owned();
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 64);
    let mut i = 0;
    while i < chars.len() {
        let Some(len) = link_at(&chars, i) else {
            out.push(chars[i]);
            i += 1;
            continue;
        };
        let m = &chars[i..i + len];
        let m_str: String = m.iter().collect();
        if utf16_len(&m_str) > MAX_URL {
            out.push_str(&m_str);
        } else {
            let end = trim_tail(m);
            let url: String = m[..end].iter().collect();
            let tail: String = m[end..].iter().collect();
            out.push_str(&tag(&url, params));
            out.push_str(&tail);
        }
        i += len;
    }
    out
}

/// Liên kết đầu tiên sau khi gắn UTM (xem trước); không có liên kết ⇒ `None`.
pub fn first_utm_link(text: &str, params: &[(String, String)]) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    (0..chars.len()).find_map(|i| {
        let len = link_at(&chars, i)?;
        let m = &chars[i..i + len];
        let url: String = m[..trim_tail(m)].iter().collect();
        if params.is_empty() {
            return Some(url);
        }
        Some(tag(&url, params))
    })
}

/// Áp UTM của một kênh lên nội dung và bình luận đầu Facebook. Không có `options.utm` (hay sai) ⇒ giữ nguyên.
pub fn apply_utm_to_target(network: &str, text: &str, options: &Map<String, Value>) -> (String, Map<String, Value>) {
    let utm = normalize_utm(options.get("utm")).ok().flatten();
    let Some(utm) = utm else {
        return (text.to_owned(), options.clone());
    };
    let params = utm_params_for(network, &utm);
    let mut next = options.clone();
    if let Some(Value::String(c)) = options.get("first_comment") {
        next.insert("first_comment".to_owned(), Value::String(apply_utm(c, &params)));
    }
    (apply_utm(text, &params), next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const Q: &str = "utm_source=facebook&utm_medium=social&utm_campaign=thu-2026";

    fn params() -> Vec<(String, String)> {
        let utm = UtmInput {
            campaign: "thu-2026".to_owned(),
            content: None,
        };
        utm_params_for("facebook", &utm)
    }

    fn err_of(v: Value) -> String {
        normalize_utm(Some(&v)).unwrap_err()
    }

    fn gan(text: &str) -> String {
        apply_utm(text, &params())
    }

    #[test]
    fn chuan_hoa() {
        assert_eq!(normalize_utm(None), Ok(None));
        assert_eq!(normalize_utm(Some(&Value::Null)), Ok(None));
        let u = normalize_utm(Some(&json!({"campaign": "  Thu  2026 ", "content": " a b "})));
        let u = u.unwrap().unwrap();
        assert_eq!(u.campaign, "Thu-2026");
        assert_eq!(u.content.as_deref(), Some("a-b"));
        let u = normalize_utm(Some(&json!({"campaign": "x", "content": ""})));
        assert_eq!(u.unwrap().unwrap().content, None);
        assert_eq!(err_of(json!("x")), "UTM: định dạng không hợp lệ.");
        let missing = err_of(json!({}));
        assert_eq!(missing, "UTM: cần chiến dịch (campaign) 1–100 ký tự.");
        let blank = err_of(json!({"campaign": "   "}));
        assert_eq!(blank, "UTM: tên chiến dịch (campaign) không được để trống.");
        let bad = err_of(json!({"campaign": "a&b"}));
        assert!(bad.ends_with("không được chứa các ký tự & # = ? % /."));
        let not_text = err_of(json!({"campaign": "a", "content": 1}));
        assert_eq!(not_text, "UTM: utm_content phải là chữ.");
        assert!(normalize_utm(Some(&json!({"campaign": "a".repeat(101)}))).is_err());
    }

    #[test]
    fn gan_vao_lien_ket() {
        let want = format!("Xem https://shop.vn/a?{Q}.");
        assert_eq!(gan("Xem https://shop.vn/a."), want);
        let want = format!("**https://shop.vn?{Q}**");
        assert_eq!(gan("**https://shop.vn**"), want);
        let want = format!("https://shop.vn/a?x=1&{Q}#top");
        assert_eq!(gan("https://shop.vn/a?x=1#top"), want);
        // Đã có utm_ thì giữ nguyên; gọi hai lần cho cùng kết quả.
        let keep = "https://shop.vn/?UTM_source=z";
        assert_eq!(gan(keep), keep);
        let once = gan("a https://x.vn b");
        assert_eq!(gan(&once), once);
        // Ngoặc đóng chỉ giữ khi có ngoặc mở.
        let want = format!("(https://x.vn/a_(b)?{Q})");
        assert_eq!(gan("(https://x.vn/a_(b))"), want);
        assert_eq!(gan("không có"), "không có");
        assert_eq!(gan("https://"), "https://");
        assert_eq!(apply_utm("x", &[]), "x");
    }

    #[test]
    fn lien_ket_dau_tien() {
        let first = first_utm_link("a http://x.vn/b, c https://y.vn", &params());
        assert_eq!(first, Some(format!("http://x.vn/b?{Q}")));
        assert_eq!(first_utm_link("không có", &params()), None);
        assert_eq!(first_utm_link("http://x.vn.", &[]).as_deref(), Some("http://x.vn"));
    }

    #[test]
    fn ap_vao_kenh() {
        let mut o = Map::new();
        o.insert("utm".to_owned(), json!({"campaign": "thu-2026"}));
        o.insert("first_comment".to_owned(), json!("Mua tại https://x.vn"));
        let (text, next) = apply_utm_to_target("facebook", "Xem https://x.vn", &o);
        assert_eq!(text, format!("Xem https://x.vn?{Q}"));
        assert_eq!(next["first_comment"], format!("Mua tại https://x.vn?{Q}"));
        // Không có utm ⇒ nguyên văn.
        let (t, n) = apply_utm_to_target("facebook", "Xem https://x.vn", &Map::new());
        assert_eq!(t, "Xem https://x.vn");
        assert!(n.is_empty());
    }
}
