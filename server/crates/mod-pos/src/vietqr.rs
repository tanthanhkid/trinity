//! VietQR / NAPAS 247 (EMVCo): dựng CHUỖI QR chuyển khoản, không gọi API ngân hàng (FE vẽ QR từ chuỗi). Bản TS:
//! `vietqr.util.ts`. Tag: 00 phiên bản, 01 (11 tĩnh / 12 động), 38 NAPAS (GUID `A000000727` + BIN + STK + `QRIBFTTA`),
//! 53 = 704 (VND), 54 số tiền, 58 = VN, 62/08 nội dung, 63 CRC16-CCITT-FALSE.

const NAPAS_GUID: &str = "A000000727";

fn tlv(id: &str, value: &str) -> String {
    format!("{id}{:02}{value}", value.chars().count())
}

/// CRC16 CCITT-FALSE (poly 0x1021, init 0xFFFF): 4 ký tự hex HOA.
pub fn crc16(input: &str) -> String {
    let mut crc: u16 = 0xFFFF;
    for b in input.bytes() {
        crc ^= u16::from(b) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    format!("{crc:04X}")
}

/// Bỏ dấu tiếng Việt: chữ có dấu dựng sẵn về chữ gốc, dấu rời (U+0300..U+036F) bị bỏ, `đ`/`Đ` thành `d`/`D`.
fn fold(c: char) -> char {
    const GROUPS: [(char, &str); 7] = [
        ('a', "àáảãạăằắẳẵặâầấẩẫậ"),
        ('e', "èéẻẽẹêềếểễệ"),
        ('i', "ìíỉĩị"),
        ('o', "òóỏõọôồốổỗộơờớởỡợ"),
        ('u', "ùúủũụưừứửữự"),
        ('y', "ỳýỷỹỵ"),
        ('d', "đ"),
    ];
    let lower = c.to_lowercase().next().unwrap_or(c);
    for (base, set) in GROUPS {
        if set.contains(lower) {
            return if c.is_uppercase() {
                base.to_ascii_uppercase()
            } else {
                base
            };
        }
    }
    c
}

/// Nội dung CK: bỏ dấu, chỉ ASCII an toàn (`A-Z a-z 0-9 space . _ -`), tối đa 25 ký tự.
pub fn sanitize_qr_message(msg: &str) -> String {
    msg.chars()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .map(fold)
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
        .take(25)
        .collect()
}

/// `bin` 6 chữ số, `account_no` 4–19 chữ số; có `amount > 0` ⇒ QR động.
pub fn build_vietqr(bin: &str, account_no: &str, amount: Option<i64>, message: Option<&str>) -> Result<String, String> {
    let digits = |s: &str, lo: usize, hi: usize| (lo..=hi).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(bin, 6, 6) {
        return Err("BIN ngân hàng phải gồm 6 chữ số".into());
    }
    if !digits(account_no, 4, 19) {
        return Err("Số tài khoản phải gồm 4–19 chữ số".into());
    }
    let amount = amount.filter(|a| *a > 0);
    let bank = tlv("00", bin) + &tlv("01", account_no);
    let merchant = tlv("00", NAPAS_GUID) + &tlv("01", &bank) + &tlv("02", "QRIBFTTA");
    let mut body = tlv("00", "01")
        + &tlv("01", if amount.is_some() { "12" } else { "11" })
        + &tlv("38", &merchant)
        + &tlv("53", "704");
    if let Some(a) = amount {
        body += &tlv("54", &a.to_string());
    }
    body += &tlv("58", "VN");
    let msg = message.map(sanitize_qr_message).unwrap_or_default();
    if !msg.is_empty() {
        body += &tlv("62", &tlv("08", &msg));
    }
    body += "6304";
    let crc = crc16(&body);
    Ok(body + &crc)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> std::collections::HashMap<String, String> {
        let mut out = std::collections::HashMap::new();
        let mut i = 0;
        while i + 4 <= s.len() {
            let n: usize = s[i + 2..i + 4].parse().unwrap();
            out.insert(s[i..i + 2].to_owned(), s[i + 4..i + 4 + n].to_owned());
            i += 4 + n;
        }
        out
    }

    #[test]
    fn crc_dung_vector_chuan() {
        assert_eq!(crc16("123456789"), "29B1");
    }

    #[test]
    fn qr_dong_va_tinh() {
        let qr = build_vietqr("970436", "0123456789", Some(125_000), Some("HD20260930-0001")).unwrap();
        let t = parse(&qr);
        assert_eq!(
            (
                t["00"].as_str(),
                t["01"].as_str(),
                t["53"].as_str(),
                t["54"].as_str(),
                t["58"].as_str()
            ),
            ("01", "12", "704", "125000", "VN")
        );
        let n = parse(&t["38"]);
        assert_eq!((n["00"].as_str(), n["02"].as_str()), ("A000000727", "QRIBFTTA"));
        assert_eq!(parse(&n["01"])["01"], "0123456789");
        assert_eq!(parse(&t["62"])["08"], "HD20260930-0001");
        assert_eq!(&qr[qr.len() - 4..], crc16(&qr[..qr.len() - 4]));
        let s = parse(&build_vietqr("970436", "0123456789", None, None).unwrap());
        assert_eq!(s["01"], "11");
        assert!(!s.contains_key("54"));
        assert!(build_vietqr("9704", "0123456789", None, None).is_err());
        assert!(build_vietqr("970436", "12", None, None).is_err());
    }

    #[test]
    fn noi_dung_bo_dau_va_cat_25() {
        assert_eq!(sanitize_qr_message("Thanh toán đơn Đà Nẵng!"), "Thanh toan don Da Nang");
        assert_eq!(sanitize_qr_message(&"a".repeat(40)).len(), 25);
        assert_eq!(sanitize_qr_message("Tie\u{301}ng"), "Tieng");
    }
}
