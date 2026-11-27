//! Đọc CSV nhập bài (`social-csv.ts`): RFC 4180, dấu phẩy hoặc chấm phẩy, tiêu đề tiếng Việt có dấu, giờ Việt Nam.
//! Thuần tuý, không đọc DB hay đồng hồ; lỗi trả `HttpError` 400 như `BadRequestException`.

use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use serde::Serialize;
use trinity_kernel::error::HttpError;
use trinity_kernel::vi::fold_vi;
use trinity_kernel::vn_time::vn_to_utc;

/// Nhập nhiều bài từ CSV: tối đa 200 dòng, 1 MB chữ.
pub const IMPORT_MAX_ROWS: usize = 200;
pub const IMPORT_MAX_BYTES: usize = 1024 * 1024;

/// Một bản ghi CSV: `line` là dòng bắt đầu bản ghi trong tệp (1 = tiêu đề); trường nhiều dòng trong ngoặc kép vẫn
/// tính dòng đầu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CsvRecord {
    pub line: usize,
    pub cells: Vec<String>,
}

/// Dấu phân cách theo dòng tiêu đề: dấu nào (ngoài ngoặc kép) nhiều hơn thì dùng; hoà ⇒ dấu phẩy.
pub fn detect_delimiter(text: &str) -> char {
    let (mut comma, mut semi, mut quoted) = (0_usize, 0_usize, false);
    for ch in text.chars() {
        if ch == '"' {
            quoted = !quoted;
        } else if !quoted {
            match ch {
                '\n' | '\r' => break,
                ',' => comma += 1,
                ';' => semi += 1,
                _ => {}
            }
        }
    }
    if semi > comma { ';' } else { ',' }
}

/// Bộ gom ô/bản ghi cho [`parse_csv_records`].
struct Acc {
    records: Vec<CsvRecord>,
    cells: Vec<String>,
    cell: String,
    was_quoted: bool,
    start_line: usize,
}

impl Acc {
    fn end_cell(&mut self) {
        self.cells.push(std::mem::take(&mut self.cell));
        self.was_quoted = false;
    }

    fn end_record(&mut self) {
        self.end_cell();
        let cells = std::mem::take(&mut self.cells);
        // Dòng trống hoàn toàn bị bỏ.
        if cells.iter().any(|c| !c.trim().is_empty()) {
            self.records.push(CsvRecord {
                line: self.start_line,
                cells,
            });
        }
    }
}

/// Bóc CSV theo RFC 4180: trường trong ngoặc kép (chứa dấu phân cách / xuống dòng), `""` = một dấu nháy, CRLF/LF/CR,
/// bỏ BOM UTF-8. Dòng trống hoàn toàn bị bỏ. Ngoặc kép không đóng ⇒ 400.
pub fn parse_csv_records(text: &str, delimiter: Option<char>) -> Result<(char, Vec<CsvRecord>), HttpError> {
    let src = text.strip_prefix('\u{feff}').unwrap_or(text);
    let d = delimiter.unwrap_or_else(|| detect_delimiter(src));
    let chars: Vec<char> = src.chars().collect();
    let mut acc = Acc {
        records: Vec::new(),
        cells: Vec::new(),
        cell: String::new(),
        was_quoted: false,
        start_line: 1,
    };
    let (mut quoted, mut line, mut quote_line) = (false, 1_usize, 1_usize);
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if quoted {
            if ch == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    acc.cell.push('"');
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                if ch == '\n' {
                    line += 1;
                }
                acc.cell.push(ch);
            }
            i += 1;
            continue;
        }
        if ch == '"' && acc.cell.is_empty() && !acc.was_quoted {
            quoted = true;
            acc.was_quoted = true;
            quote_line = line;
        } else if ch == d {
            acc.end_cell();
        } else if ch == '\r' || ch == '\n' {
            if ch == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            acc.end_record();
            line += 1;
            acc.start_line = line;
        } else {
            acc.cell.push(ch);
        }
        i += 1;
    }
    if quoted {
        return Err(HttpError::bad_request(format!(
            "CSV: dấu ngoặc kép mở ở dòng {quote_line} không được đóng."
        )));
    }
    if !acc.cell.is_empty() || !acc.cells.is_empty() || acc.was_quoted {
        acc.end_record();
    }
    Ok((d, acc.records))
}

/// Dòng nhập đã chuẩn về tên cột chính (trường trống = `None` / mảng rỗng / `false`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct ImportRowInput {
    /// Số dòng (CSV: dòng trong tệp, dòng tiêu đề là 1; MCP: thứ tự 1…n).
    pub row: usize,
    pub content: Option<String>,
    /// id kênh (dạng số) hoặc tên kênh đúng như hiển thị.
    pub channels: Vec<String>,
    /// Giờ Việt Nam `YYYY-MM-DD HH:mm` / `DD/MM/YYYY HH:mm` / ISO 8601.
    pub scheduled_at: Option<String>,
    /// `queue` hoặc `hàng đợi` ở cột giờ đăng.
    pub use_queue: bool,
    /// Khoá tệp hoặc tên tệp trong thư viện.
    pub media: Vec<String>,
    pub first_comment: Option<String>,
    pub utm_campaign: Option<String>,
}

/// Bỏ dấu, thường hoá, mọi chuỗi ký tự không phải chữ/số thành một `_`, cắt `_` đầu cuối (`normHeader`).
pub fn norm_header(h: &str) -> String {
    let mut out = String::new();
    let mut pending = false;
    for c in fold_vi(h).chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if pending && !out.is_empty() {
                out.push('_');
            }
            pending = false;
            out.push(c);
        } else {
            pending = true;
        }
    }
    out
}

/// `true` khi ô giờ đăng là "queue" hoặc "hàng đợi".
pub fn is_queue_word(v: &str) -> bool {
    matches!(norm_header(v).as_str(), "queue" | "hang_doi")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Col {
    Content,
    Channels,
    ScheduledAt,
    Media,
    FirstComment,
    UtmCampaign,
}

fn alias(norm: &str) -> Option<Col> {
    Some(match norm {
        "content" | "noi_dung" => Col::Content,
        "channels" | "channel" | "kenh" => Col::Channels,
        "scheduled_at" | "gio_dang" => Col::ScheduledAt,
        "media" | "tep" => Col::Media,
        "first_comment" | "binh_luan_dau" => Col::FirstComment,
        "utm_campaign" | "utm" => Col::UtmCampaign,
        _ => return None,
    })
}

fn split_list(v: &str, seps: &[char]) -> Vec<String> {
    v.split(|c| seps.contains(&c))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Kết quả [`parse_csv`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCsv {
    pub delimiter: char,
    pub rows: Vec<ImportRowInput>,
    pub unknown_columns: Vec<String>,
}

/// CSV → các dòng nhập (có số dòng). Kiểm giới hạn kích thước/số dòng và cột bắt buộc.
pub fn parse_csv(text: &str) -> Result<ParsedCsv, HttpError> {
    if text.trim().is_empty() {
        return Err(HttpError::bad_request("CSV trống."));
    }
    if text.len() > IMPORT_MAX_BYTES {
        return Err(HttpError::bad_request("CSV tối đa 1 MB."));
    }
    let (delimiter, records) = parse_csv_records(text, None)?;
    let Some((head, body)) = records.split_first() else {
        return Err(HttpError::bad_request("CSV trống."));
    };
    let mut cols: Vec<(usize, Col)> = Vec::new();
    let mut unknown = Vec::new();
    for (i, h) in head.cells.iter().enumerate() {
        let Some(key) = alias(&norm_header(h)) else {
            if !h.trim().is_empty() {
                unknown.push(h.trim().to_owned());
            }
            continue;
        };
        if cols.iter().any(|(_, k)| *k == key) {
            return Err(HttpError::bad_request(format!(
                "CSV: cột \"{}\" trùng với một cột đã có.",
                h.trim()
            )));
        }
        cols.push((i, key));
    }
    let has = |c: Col| cols.iter().any(|(_, k)| *k == c);
    if !has(Col::Content) && !has(Col::Media) {
        return Err(HttpError::bad_request(
            "CSV cần dòng tiêu đề có cột content (noi_dung) hoặc media (tep).",
        ));
    }
    if body.is_empty() {
        return Err(HttpError::bad_request("CSV chưa có dòng dữ liệu nào."));
    }
    if body.len() > IMPORT_MAX_ROWS {
        return Err(HttpError::bad_request(format!(
            "Tối đa {IMPORT_MAX_ROWS} dòng mỗi lần nhập (CSV có {}).",
            body.len()
        )));
    }
    let rows = body
        .iter()
        .map(|r| {
            let mut row = ImportRowInput {
                row: r.line,
                ..ImportRowInput::default()
            };
            for (i, key) in &cols {
                let v = r.cells.get(*i).map_or("", |c| c.trim());
                if v.is_empty() {
                    continue;
                }
                match key {
                    Col::Channels => row.channels = split_list(v, &[';', ',']),
                    Col::Media => row.media = split_list(v, &[';']),
                    Col::ScheduledAt => {
                        if is_queue_word(v) {
                            row.use_queue = true;
                        } else {
                            row.scheduled_at = Some(v.to_owned());
                        }
                    }
                    Col::Content => row.content = Some(v.to_owned()),
                    Col::FirstComment => row.first_comment = Some(v.to_owned()),
                    Col::UtmCampaign => row.utm_campaign = Some(v.to_owned()),
                }
            }
            row
        })
        .collect();
    Ok(ParsedCsv {
        delimiter,
        rows,
        unknown_columns: unknown,
    })
}

fn all_digits(s: &str, min: usize, max: usize) -> Option<u32> {
    if s.len() < min || s.len() > max || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// `H:mm[:ss]` (giờ 1–2 chữ số, phút và giây 2 chữ số).
fn hms(s: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<&str> = s.split(':').collect();
    match parts.as_slice() {
        [h, m] => Some((all_digits(h, 1, 2)?, all_digits(m, 2, 2)?, 0)),
        [h, m, sec] => Some((all_digits(h, 1, 2)?, all_digits(m, 2, 2)?, all_digits(sec, 2, 2)?)),
        _ => None,
    }
}

/// `YYYY-MM-DD H:mm[:ss]` hoặc `DD/MM/YYYY H:mm[:ss]` (ngăn ngày/giờ bằng `T` hoặc một dấu cách) → (năm, tháng, ngày, giờ, phút, giây).
fn local_parts(s: &str) -> Option<(u32, u32, u32, u32, u32, u32)> {
    let (date, time) = s.split_once(['T', ' '])?;
    let (h, mi, sec) = hms(time)?;
    let iso: Vec<&str> = date.split('-').collect();
    if let [y, mo, d] = iso.as_slice() {
        return Some((
            all_digits(y, 4, 4)?,
            all_digits(mo, 1, 2)?,
            all_digits(d, 1, 2)?,
            h,
            mi,
            sec,
        ));
    }
    let dmy: Vec<&str> = date.split('/').collect();
    if let [d, mo, y] = dmy.as_slice() {
        return Some((
            all_digits(y, 4, 4)?,
            all_digits(mo, 1, 2)?,
            all_digits(d, 1, 2)?,
            h,
            mi,
            sec,
        ));
    }
    None
}

/// ISO 8601 có múi giờ rõ ràng (`Z`, `+07:00`, `+0700`): giờ có thể thiếu giây, có phần lẻ giây.
fn iso_with_zone(s: &str) -> Option<DateTime<Utc>> {
    let b = s.as_bytes();
    let shape = b.len() > 11
        && b[4] == b'-'
        && b[7] == b'-'
        && (b[10] == b'T' || b[10] == b't')
        && b[..4].iter().chain(&b[5..7]).chain(&b[8..10]).all(u8::is_ascii_digit);
    if !shape {
        return None;
    }
    let date = NaiveDate::from_ymd_opt(s[..4].parse().ok()?, s[5..7].parse().ok()?, s[8..10].parse().ok()?)?;
    let rest = &s[11..];
    let zone_at = rest.rfind(['Z', 'z', '+', '-'])?;
    let (clock, zone) = rest.split_at(zone_at);
    let (hm, frac) = match clock.split_once('.') {
        Some((a, f)) => (a, Some(f)),
        None => (clock, None),
    };
    let (h, mi, sec) = hms_strict(hm)?;
    let ms = match frac {
        Some(f) if !f.is_empty() && f.bytes().all(|c| c.is_ascii_digit()) => {
            format!("{:0<3}", &f[..f.len().min(3)]).parse::<u32>().ok()?
        }
        Some(_) => return None,
        None => 0,
    };
    let offset_secs: i64 = match zone {
        "Z" | "z" => 0,
        z => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let digits: String = z[1..].chars().filter(|c| *c != ':').collect();
            if digits.len() != 4 || !digits.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let zh: i64 = digits[..2].parse().ok()?;
            let zm: i64 = digits[2..].parse().ok()?;
            if zh > 23 || zm > 59 {
                return None;
            }
            sign * (zh * 3600 + zm * 60)
        }
    };
    let naive = date.and_time(NaiveTime::from_hms_milli_opt(h, mi, sec, ms)?);
    let utc = naive.and_utc() - chrono::Duration::seconds(offset_secs);
    Some(utc)
}

/// `HH:mm` hoặc `HH:mm:ss` (đúng 2 chữ số mỗi phần) cho nhánh ISO.
fn hms_strict(s: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<&str> = s.split(':').collect();
    match parts.as_slice() {
        [h, m] => Some((all_digits(h, 2, 2)?, all_digits(m, 2, 2)?, 0)),
        [h, m, sec] => Some((all_digits(h, 2, 2)?, all_digits(m, 2, 2)?, all_digits(sec, 2, 2)?)),
        _ => None,
    }
}

/// Giờ Việt Nam (UTC+7, không giờ mùa hè) → UTC. Nhận `YYYY-MM-DD HH:mm[:ss]`, `YYYY-MM-DDTHH:mm`,
/// `DD/MM/YYYY HH:mm`, hoặc ISO có múi giờ. Sai (kể cả ngày không có thật: 31/02, tháng 13, giờ 25) ⇒ `Err` tiếng Việt.
pub fn parse_vn_time(raw: &str) -> Result<DateTime<Utc>, String> {
    let s = raw.trim();
    let bad = || {
        let shown: String = s.chars().take(40).collect();
        format!("Giờ \"{shown}\" không đúng dạng — dùng YYYY-MM-DD HH:mm hoặc DD/MM/YYYY HH:mm (giờ Việt Nam).")
    };
    if let Some((y, mo, d, h, mi, sec)) = local_parts(s) {
        // Như bản Node: năm 0–99 bị `Date.UTC` đổi thành 19xx nên không khứ hồi được ⇒ coi là sai.
        if y < 100 {
            return Err(bad());
        }
        let date = i32::try_from(y).ok().and_then(|y| NaiveDate::from_ymd_opt(y, mo, d));
        let time = NaiveTime::from_hms_opt(h, mi, sec);
        return match (date, time) {
            (Some(date), Some(time)) => Ok(vn_to_utc(date, time)),
            _ => Err(bad()),
        };
    }
    iso_with_zone(s).ok_or_else(bad)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cells(rs: &[CsvRecord]) -> Vec<Vec<&str>> {
        rs.iter()
            .map(|r| r.cells.iter().map(String::as_str).collect())
            .collect()
    }

    fn iso(t: DateTime<Utc>) -> String {
        trinity_kernel::vn_time::js_iso_string(t)
    }

    #[test]
    fn truong_trong_ngoac_kep() {
        let (_, rs) = parse_csv_records("a,b\n\"x, y\",\"dòng 1\ndòng 2\"\n\"nói \"\"hi\"\"\",z", None).unwrap();
        assert_eq!(
            cells(&rs),
            vec![vec!["a", "b"], vec!["x, y", "dòng 1\ndòng 2"], vec!["nói \"hi\"", "z"]]
        );
        assert_eq!(rs.iter().map(|r| r.line).collect::<Vec<_>>(), vec![1, 2, 4]);
    }

    #[test]
    fn crlf_cr_bom_dong_trong() {
        let (_, rs) = parse_csv_records("\u{feff}a,b\r\n1,2\r\n\r\n3,4", None).unwrap();
        assert_eq!(cells(&rs), vec![vec!["a", "b"], vec!["1", "2"], vec!["3", "4"]]);
        assert_eq!(parse_csv_records("a,b\r1,2", None).unwrap().1.len(), 2);
    }

    #[test]
    fn dau_phan_cach() {
        let (d, rs) = parse_csv_records("a;b;c\n1;2;3", None).unwrap();
        assert_eq!(d, ';');
        assert_eq!(cells(&rs)[1], vec!["1", "2", "3"]);
        assert_eq!(parse_csv_records("a,b,c\n1,2,3", None).unwrap().0, ',');
        assert_eq!(parse_csv_records("\"a;b;c\",d\n1,2", None).unwrap().0, ',');
    }

    #[test]
    fn o_trong_cuoi_dong_va_ngoac_khong_dong() {
        let (_, rs) = parse_csv_records("a,b,c\n1,,", None).unwrap();
        assert_eq!(cells(&rs)[1], vec!["1", "", ""]);
        let e = parse_csv_records("a,b\n\"x,y", None).unwrap_err();
        assert_eq!(e.status(), 400);
    }

    #[test]
    fn tieu_de_bi_danh() {
        let p = parse_csv("Nội dung;Kênh;Giờ đăng;Tệp\n\"Xin chào\";Fanpage;24/10/2026 09:30;a.png\n").unwrap();
        assert_eq!(
            p.rows,
            vec![ImportRowInput {
                row: 2,
                content: Some("Xin chào".into()),
                channels: vec!["Fanpage".into()],
                scheduled_at: Some("24/10/2026 09:30".into()),
                media: vec!["a.png".into()],
                ..ImportRowInput::default()
            }]
        );
    }

    #[test]
    fn map_du_cot_va_cot_la() {
        let csv = "noi_dung,kenh,gio_dang,tep,binh_luan_dau,tieu_de_youtube,utm\n\
                   \"Bài 1\",\"Fanpage; 12\",\"2026-10-24 09:30\",\"a.png;b mp4.mp4\",\"bình luận\",\"tiêu đề\",thu-10";
        let p = parse_csv(csv).unwrap();
        assert_eq!(p.unknown_columns, vec!["tieu_de_youtube"]);
        let r = &p.rows[0];
        assert_eq!(r.channels, vec!["Fanpage", "12"]);
        assert_eq!(r.media, vec!["a.png", "b mp4.mp4"]);
        assert_eq!(r.first_comment.as_deref(), Some("bình luận"));
        assert_eq!(r.utm_campaign.as_deref(), Some("thu-10"));
        let en = parse_csv(
            "Content,Channels,Scheduled_At,Media,First Comment,UTM_Campaign\nx,\"a,b\",2026-10-24 09:30,k,c,u",
        )
        .unwrap();
        assert_eq!(en.rows[0].channels, vec!["a", "b"]);
        assert_eq!(en.rows[0].utm_campaign.as_deref(), Some("u"));
    }

    #[test]
    fn gio_dang_hang_doi() {
        let p = parse_csv("noi_dung,gio_dang\na,queue\nb,Hàng đợi\nc,\n").unwrap();
        let v: Vec<_> = p.rows.iter().map(|r| (r.use_queue, r.scheduled_at.clone())).collect();
        assert_eq!(v, vec![(true, None), (true, None), (false, None)]);
    }

    #[test]
    fn loi_tieu_de() {
        assert_eq!(
            parse_csv("content,ghi_chu\nx,y").unwrap().unknown_columns,
            vec!["ghi_chu"]
        );
        let msg = |s: &str| parse_csv(s).unwrap_err().to_string();
        assert!(msg("kenh,gio_dang\na,b").contains("content"));
        assert!(msg("content,noi_dung\na,b").contains("trùng"));
        assert!(msg("content\n").contains("chưa có dòng dữ liệu"));
        assert!(msg("  ").contains("trống"));
    }

    #[test]
    fn gioi_han_dong_va_dung_luong() {
        let ok: String = std::iter::once("content".to_owned())
            .chain((0..IMPORT_MAX_ROWS).map(|i| format!("bài {i}")))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(parse_csv(&ok).unwrap().rows.len(), IMPORT_MAX_ROWS);
        assert!(
            parse_csv(&format!("{ok}\nbài thừa"))
                .unwrap_err()
                .to_string()
                .contains("Tối đa 200 dòng")
        );
        let big = format!("content\n{}", "x".repeat(1024 * 1024));
        assert!(parse_csv(&big).unwrap_err().to_string().contains("1 MB"));
    }

    #[test]
    fn norm_header_bo_dau() {
        assert_eq!(norm_header(" Bình luận đầu "), "binh_luan_dau");
        assert_eq!(norm_header("UTM-Campaign"), "utm_campaign");
        assert_eq!(norm_header("--"), "");
    }

    #[test]
    fn gio_viet_nam() {
        assert_eq!(
            iso(parse_vn_time("2026-10-24 09:30").unwrap()),
            "2026-10-24T02:30:00.000Z"
        );
        assert_eq!(
            iso(parse_vn_time("24/10/2026 09:30").unwrap()),
            "2026-10-24T02:30:00.000Z"
        );
        assert_eq!(iso(parse_vn_time("4/1/2026 7:05").unwrap()), "2026-01-04T00:05:00.000Z");
        assert_eq!(
            iso(parse_vn_time("2026-10-24 00:30").unwrap()),
            "2026-10-23T17:30:00.000Z"
        );
        assert_eq!(
            iso(parse_vn_time("2026-10-24T09:30").unwrap()),
            "2026-10-24T02:30:00.000Z"
        );
        assert_eq!(
            iso(parse_vn_time("2026-10-24T09:30:00+07:00").unwrap()),
            "2026-10-24T02:30:00.000Z"
        );
        assert_eq!(
            iso(parse_vn_time("2026-10-24T09:30:00+0700").unwrap()),
            "2026-10-24T02:30:00.000Z"
        );
        assert_eq!(
            iso(parse_vn_time("2026-10-24T02:30:00Z").unwrap()),
            "2026-10-24T02:30:00.000Z"
        );
        assert_eq!(
            iso(parse_vn_time("2026-10-24T02:30:00.5Z").unwrap()),
            "2026-10-24T02:30:00.500Z"
        );
    }

    #[test]
    fn gio_sai() {
        for bad in [
            "2026-02-31 09:00",
            "2026-13-01 09:00",
            "2026-10-24 25:00",
            "24-10-2026 09:00",
            "2026-10-24",
            "mai 9h",
            "",
            "0026-10-24 09:00",
            "2026-10-24 09:60",
        ] {
            let e = parse_vn_time(bad).unwrap_err();
            assert!(e.contains("không đúng dạng"), "{bad}");
        }
    }
}
