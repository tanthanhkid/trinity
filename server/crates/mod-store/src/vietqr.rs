//! Chuỗi VietQR (chuẩn EMVCo Merchant-Presented QR, hồ sơ NAPAS "chuyển tiền tới tài khoản") của trang bán hàng, chuyển từ
//! `services/crm/src/store/vietqr.ts`. Sinh hoàn toàn trong máy chủ, KHÔNG gọi dịch vụ ngoài; trình duyệt vẽ chuỗi thành mã QR.
//! Bảng ca dùng chung với bản TS: `server/contracts/cases/vietqr.json` (`tests/vietqr_cases.rs`).
//!
//! Cấu trúc (mỗi trường = ID 2 số + độ dài 2 số + giá trị): `00 "01"` · `01 "12"` (QR động, có số tiền) ·
//! `38 { 00 "A000000727" · 01 { 00 BIN · 01 số TK } · 02 "QRIBFTTA" }` · `53 "704"` · `54 số tiền` · `58 "VN"` ·
//! `62 { 08 nội dung }` · `63 CRC16-CCITT-FALSE` (4 hex in hoa) tính trên mọi thứ tới `6304`.
//!
//! Khác `mod_pos::vietqr` (QR của POS: số tiền tuỳ chọn, nội dung cho phép `.`/`_`): trang bán hàng luôn có số tiền, nội
//! dung = mã đơn, chỉ chữ/số/dấu cách/gạch.

use unicode_normalization::UnicodeNormalization;

/// Ngân hàng nhận VietQR: mã BIN 6 số (NAPAS), tên ngắn hiển thị, và các tên/mã viết kiểu SePay/VietQR để ánh xạ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VietQrBank {
    pub bin: &'static str,
    pub name: &'static str,
    pub aliases: &'static [&'static str],
}

/// Bảng ánh xạ tên ngân hàng (kiểu SePay "MBBank", "Vietcombank"…, hoặc mã "VCB", "ICB"…) → BIN. Nguồn: danh sách công khai của
/// VietQR (`https://api.vietqr.io/v2/banks`), đối chiếu 26/11/2026. Tên so khớp sau khi bỏ mọi ký tự ngoài chữ/số, không phân biệt
/// hoa thường. Migration `0022_store_vietqr` chép đúng bảng này; `tests/vietqr_cases.rs` kiểm khớp bảng dùng chung với bản TS.
pub const VIETQR_BANKS: &[VietQrBank] = &[
    VietQrBank {
        bin: "970436",
        name: "Vietcombank",
        aliases: &["vietcombank", "vcb"],
    },
    VietQrBank {
        bin: "970415",
        name: "VietinBank",
        aliases: &["vietinbank", "icb", "ctg"],
    },
    VietQrBank {
        bin: "970418",
        name: "BIDV",
        aliases: &["bidv"],
    },
    VietQrBank {
        bin: "970405",
        name: "Agribank",
        aliases: &["agribank", "vba"],
    },
    VietQrBank {
        bin: "970422",
        name: "MBBank",
        aliases: &["mbbank", "mb"],
    },
    VietQrBank {
        bin: "970407",
        name: "Techcombank",
        aliases: &["techcombank", "tcb"],
    },
    VietQrBank {
        bin: "970416",
        name: "ACB",
        aliases: &["acb"],
    },
    VietQrBank {
        bin: "970432",
        name: "VPBank",
        aliases: &["vpbank", "vpb"],
    },
    VietQrBank {
        bin: "970423",
        name: "TPBank",
        aliases: &["tpbank", "tpb"],
    },
    VietQrBank {
        bin: "970403",
        name: "Sacombank",
        aliases: &["sacombank", "stb"],
    },
    VietQrBank {
        bin: "970437",
        name: "HDBank",
        aliases: &["hdbank", "hdb"],
    },
    VietQrBank {
        bin: "970441",
        name: "VIB",
        aliases: &["vib"],
    },
    VietQrBank {
        bin: "970443",
        name: "SHB",
        aliases: &["shb"],
    },
    VietQrBank {
        bin: "970431",
        name: "Eximbank",
        aliases: &["eximbank", "eib"],
    },
    VietQrBank {
        bin: "970426",
        name: "MSB",
        aliases: &["msb", "maritimebank"],
    },
    VietQrBank {
        bin: "970429",
        name: "SCB",
        aliases: &["scb"],
    },
    VietQrBank {
        bin: "970440",
        name: "SeABank",
        aliases: &["seabank", "seab"],
    },
    VietQrBank {
        bin: "970448",
        name: "OCB",
        aliases: &["ocb"],
    },
    VietQrBank {
        bin: "970449",
        name: "LPBank",
        aliases: &["lpbank", "lienvietpostbank", "lpb"],
    },
    VietQrBank {
        bin: "970428",
        name: "Nam A Bank",
        aliases: &["namabank", "nab"],
    },
    VietQrBank {
        bin: "970412",
        name: "PVcomBank",
        aliases: &["pvcombank", "pvcb"],
    },
    VietQrBank {
        bin: "970409",
        name: "Bac A Bank",
        aliases: &["bacabank", "bab"],
    },
    VietQrBank {
        bin: "970425",
        name: "ABBANK",
        aliases: &["abbank", "abb"],
    },
    VietQrBank {
        bin: "970427",
        name: "VietABank",
        aliases: &["vietabank", "vab"],
    },
    VietQrBank {
        bin: "970419",
        name: "NCB",
        aliases: &["ncb"],
    },
    VietQrBank {
        bin: "970452",
        name: "KienlongBank",
        aliases: &["kienlongbank", "klb"],
    },
    VietQrBank {
        bin: "970454",
        name: "BVBank",
        aliases: &["bvbank", "vietcapitalbank", "vccb"],
    },
    VietQrBank {
        bin: "970433",
        name: "VietBank",
        aliases: &["vietbank"],
    },
    VietQrBank {
        bin: "970438",
        name: "BaoViet Bank",
        aliases: &["baovietbank", "bvb"],
    },
    VietQrBank {
        bin: "970400",
        name: "SaigonBank",
        aliases: &["saigonbank", "sgicb"],
    },
    VietQrBank {
        bin: "970430",
        name: "PGBank",
        aliases: &["pgbank", "pgb"],
    },
    VietQrBank {
        bin: "970408",
        name: "GPBank",
        aliases: &["gpbank", "gpb"],
    },
    VietQrBank {
        bin: "970414",
        name: "MBV (OceanBank)",
        aliases: &["oceanbank", "mbv"],
    },
    VietQrBank {
        bin: "970406",
        name: "Vikki Bank (DongA)",
        aliases: &["vikki", "vikkibank", "dongabank", "dab"],
    },
    VietQrBank {
        bin: "546034",
        name: "CAKE",
        aliases: &["cake"],
    },
    VietQrBank {
        bin: "546035",
        name: "Ubank",
        aliases: &["ubank"],
    },
    VietQrBank {
        bin: "963388",
        name: "Timo",
        aliases: &["timo"],
    },
    VietQrBank {
        bin: "970457",
        name: "Woori",
        aliases: &["woori", "wvn"],
    },
    VietQrBank {
        bin: "970424",
        name: "Shinhan Bank",
        aliases: &["shinhanbank", "shinhan", "shbvn"],
    },
    VietQrBank {
        bin: "970458",
        name: "UOB",
        aliases: &["uob", "unitedoverseas"],
    },
    VietQrBank {
        bin: "970439",
        name: "Public Bank",
        aliases: &["publicbank", "pbvn"],
    },
    VietQrBank {
        bin: "458761",
        name: "HSBC",
        aliases: &["hsbc"],
    },
    VietQrBank {
        bin: "970434",
        name: "Indovina",
        aliases: &["indovinabank", "ivb"],
    },
    VietQrBank {
        bin: "970421",
        name: "VRB",
        aliases: &["vrb"],
    },
    VietQrBank {
        bin: "970410",
        name: "Standard Chartered",
        aliases: &["standardchartered", "scvn"],
    },
];

fn alias_key(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

/// Tên/mã ngân hàng kiểu SePay hoặc BIN 6 số → ngân hàng; không có trong bảng ⇒ `None`.
pub fn find_bank(name_or_bin: &str) -> Option<&'static VietQrBank> {
    let raw = name_or_bin.trim();
    if raw.len() == 6 && raw.bytes().all(|b| b.is_ascii_digit()) {
        return VIETQR_BANKS.iter().find(|b| b.bin == raw);
    }
    let key = alias_key(raw);
    if key.is_empty() {
        return None;
    }
    VIETQR_BANKS.iter().find(|b| b.aliases.contains(&key.as_str()))
}

/// CRC-16/CCITT-FALSE (đa thức 0x1021, khởi tạo 0xFFFF): 4 ký tự hex in hoa.
pub fn crc16(text: &str) -> String {
    let mut crc: u16 = 0xffff;
    for b in text.bytes() {
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

fn tlv(id: &str, value: &str) -> Result<String, String> {
    let n = value.encode_utf16().count();
    if n > 99 {
        return Err(format!("Trường {id} quá dài"));
    }
    Ok(format!("{id}{n:02}{value}"))
}

/// Số tài khoản nhận VietQR: 4–19 chữ số/chữ cái (`/^[0-9A-Za-z]{4,19}$/`).
pub fn is_valid_account(s: &str) -> bool {
    (4..=19).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Nội dung chuyển khoản: chỉ chữ không dấu, số, dấu cách, gạch; tối đa 25 ký tự (app ngân hàng hay cắt/bỏ ký tự lạ).
pub fn content(raw: &str) -> String {
    let folded: String = raw
        .nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .map(|c| match c {
            'đ' => 'd',
            'Đ' => 'D',
            c => c,
        })
        .filter(|c| c.is_ascii_alphanumeric() || *c == ' ' || *c == '-')
        .collect();
    // `\s+` → " ", rồi trim, rồi 25 ký tự đầu.
    let squeezed = folded.split_whitespace().collect::<Vec<_>>().join(" ");
    squeezed.chars().take(25).collect()
}

/// Chuỗi VietQR chuyển tới tài khoản `account` ở ngân hàng `bin`, số tiền `amount` (VND, số nguyên dương), nội dung `text`.
/// Hàm thuần: cùng đầu vào ⇒ cùng chuỗi.
pub fn build(bin: &str, account: &str, amount: i64, text: &str) -> Result<String, String> {
    if bin.len() != 6 || !bin.bytes().all(|b| b.is_ascii_digit()) {
        return Err("BIN ngân hàng phải là 6 chữ số".to_owned());
    }
    if !is_valid_account(account) {
        return Err("Số tài khoản không hợp lệ".to_owned());
    }
    if amount <= 0 || amount.to_string().len() > 13 {
        return Err("Số tiền không hợp lệ".to_owned());
    }
    let text = content(text);
    let beneficiary = tlv("00", bin)? + &tlv("01", account)?;
    let merchant = tlv("00", "A000000727")? + &tlv("01", &beneficiary)? + &tlv("02", "QRIBFTTA")?;
    let mut body = tlv("00", "01")? + &tlv("01", "12")? + &tlv("38", &merchant)? + &tlv("53", "704")?;
    body += &tlv("54", &amount.to_string())?;
    body += &tlv("58", "VN")?;
    if !text.is_empty() {
        body += &tlv("62", &tlv("08", &text)?)?;
    }
    body.push_str("6304");
    let crc = crc16(&body);
    Ok(body + &crc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_vector_chuan() {
        assert_eq!(crc16("123456789"), "29B1");
    }

    #[test]
    fn bang_ban_khong_trung() {
        let mut bins: Vec<_> = VIETQR_BANKS.iter().map(|b| b.bin).collect();
        bins.sort_unstable();
        bins.dedup();
        assert_eq!(bins.len(), VIETQR_BANKS.len());
        let mut al: Vec<_> = VIETQR_BANKS.iter().flat_map(|b| b.aliases.iter().copied()).collect();
        let n = al.len();
        al.sort_unstable();
        al.dedup();
        assert_eq!(al.len(), n);
        assert!(
            al.iter()
                .all(|a| a.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
        );
    }
}
