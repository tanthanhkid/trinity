//! Ghi PDF A4 một cột chữ, nhúng phông TrueType Tinos (có tiếng Việt) thay `pdfkit` của bản Node (M31, phiếu lương).
//!
//! Chỉ gồm phần phiếu lương cần: trang A4, chữ (mã hoá Identity-H, mỗi ký tự là một glyph của phông nhúng), hình chữ nhật
//! tô màu, đường kẻ. Mỗi phông nhúng nguyên tệp TTF (không nén, không cắt tập con) và có bảng `ToUnicode` nên bộ trích văn
//! bản (pdftotext, pdf.js…) đọc lại đúng dấu tiếng Việt. Toạ độ nhận theo kiểu `pdfkit`: gốc ở góc trên trái, `y` là mép
//! trên dòng chữ; đơn vị point.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;

/// Tinos Regular (Apache 2.0), tương thích số đo với Times New Roman.
pub const TINOS_REGULAR: &[u8] = include_bytes!("../assets/fonts/Tinos-Regular.ttf");
/// Tinos Bold.
pub const TINOS_BOLD: &[u8] = include_bytes!("../assets/fonts/Tinos-Bold.ttf");

/// Rộng trang A4 (point).
pub const PAGE_W: f64 = 595.0;
/// Cao trang A4 (point).
pub const PAGE_H: f64 = 842.0;

#[derive(Debug, thiserror::Error)]
pub enum PdfError {
    #[error("phông TrueType không đọc được: {0}")]
    Font(&'static str),
}

fn be16(d: &[u8], o: usize) -> Option<u16> {
    d.get(o..o + 2).map(|b| u16::from_be_bytes([b[0], b[1]]))
}

fn be32(d: &[u8], o: usize) -> Option<u32> {
    d.get(o..o + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

fn bei16(d: &[u8], o: usize) -> Option<i16> {
    be16(d, o).map(|v| v as i16)
}

/// Phông TrueType đọc đủ để đo chữ và nhúng: bảng `head`, `hhea`, `hmtx`, `cmap` (định dạng 4 và 12).
struct Ttf {
    data: &'static [u8],
    units_per_em: u16,
    ascent: i16,
    descent: i16,
    bbox: [i16; 4],
    num_h_metrics: u16,
    hmtx: usize,
    cmap: HashMap<u32, u16>,
}

fn table(d: &'static [u8], tag: &[u8; 4]) -> Option<usize> {
    let n = usize::from(be16(d, 4)?);
    (0..n).find_map(|i| {
        let rec = 12 + 16 * i;
        if d.get(rec..rec + 4)? == tag {
            Some(be32(d, rec + 8)? as usize)
        } else {
            None
        }
    })
}

fn parse_format4(d: &[u8], sub: usize, map: &mut HashMap<u32, u16>) -> Option<()> {
    let seg_count = usize::from(be16(d, sub + 6)?) / 2;
    let ends = sub + 14;
    let starts = ends + seg_count * 2 + 2;
    let deltas = starts + seg_count * 2;
    let ranges = deltas + seg_count * 2;
    for i in 0..seg_count {
        let end = be16(d, ends + 2 * i)?;
        let start = be16(d, starts + 2 * i)?;
        let delta = be16(d, deltas + 2 * i)?;
        let range_off = be16(d, ranges + 2 * i)?;
        if start > end {
            continue;
        }
        for c in start..=end {
            if c == 0xFFFF {
                continue;
            }
            let gid = if range_off == 0 {
                c.wrapping_add(delta)
            } else {
                let at = ranges + 2 * i + usize::from(range_off) + 2 * usize::from(c - start);
                match be16(d, at)? {
                    0 => 0,
                    g => g.wrapping_add(delta),
                }
            };
            if gid != 0 {
                map.entry(u32::from(c)).or_insert(gid);
            }
        }
    }
    Some(())
}

fn parse_format12(d: &[u8], sub: usize, map: &mut HashMap<u32, u16>) -> Option<()> {
    let groups = be32(d, sub + 12)? as usize;
    for i in 0..groups {
        let g = sub + 16 + 12 * i;
        let start = be32(d, g)?;
        let end = be32(d, g + 4)?;
        let first = be32(d, g + 8)?;
        if start > end || end > 0x10_FFFF {
            continue;
        }
        for c in start..=end {
            if let Ok(gid) = u16::try_from(first.saturating_add(c - start))
                && gid != 0
            {
                map.entry(c).or_insert(gid);
            }
        }
    }
    Some(())
}

fn parse_cmap(d: &[u8], off: usize) -> Option<HashMap<u32, u16>> {
    let n = usize::from(be16(d, off + 2)?);
    let mut map = HashMap::new();
    for i in 0..n {
        let rec = off + 4 + 8 * i;
        let sub = off + be32(d, rec + 4)? as usize;
        match be16(d, sub)? {
            4 => parse_format4(d, sub, &mut map)?,
            12 => parse_format12(d, sub, &mut map)?,
            _ => {}
        }
    }
    Some(map)
}

impl Ttf {
    fn parse(data: &'static [u8]) -> Result<Self, PdfError> {
        const BAD: PdfError = PdfError::Font("tệp hỏng");
        let head = table(data, b"head").ok_or(PdfError::Font("thiếu bảng head"))?;
        let hhea = table(data, b"hhea").ok_or(PdfError::Font("thiếu bảng hhea"))?;
        let hmtx = table(data, b"hmtx").ok_or(PdfError::Font("thiếu bảng hmtx"))?;
        let cmap_at = table(data, b"cmap").ok_or(PdfError::Font("thiếu bảng cmap"))?;
        let units_per_em = be16(data, head + 18).ok_or(BAD)?;
        let bbox = [
            bei16(data, head + 36).ok_or(BAD)?,
            bei16(data, head + 38).ok_or(BAD)?,
            bei16(data, head + 40).ok_or(BAD)?,
            bei16(data, head + 42).ok_or(BAD)?,
        ];
        let ascent = bei16(data, hhea + 4).ok_or(BAD)?;
        let descent = bei16(data, hhea + 6).ok_or(BAD)?;
        let num_h_metrics = be16(data, hhea + 34).ok_or(BAD)?;
        if units_per_em == 0 || num_h_metrics == 0 {
            return Err(BAD);
        }
        let cmap = parse_cmap(data, cmap_at).ok_or(PdfError::Font("bảng cmap hỏng"))?;
        Ok(Self {
            data,
            units_per_em,
            ascent,
            descent,
            bbox,
            num_h_metrics,
            hmtx,
            cmap,
        })
    }

    fn glyph(&self, c: char) -> u16 {
        self.cmap.get(&(c as u32)).copied().unwrap_or(0)
    }

    /// Bề rộng tiến của glyph theo đơn vị phông.
    fn advance(&self, gid: u16) -> u16 {
        let i = usize::from(gid.min(self.num_h_metrics - 1));
        be16(self.data, self.hmtx + 4 * i).unwrap_or(0)
    }

    /// Theo thang 1000 đơn vị/em của PDF.
    fn per_mille(&self, v: i32) -> i32 {
        (f64::from(v) * 1000.0 / f64::from(self.units_per_em)).round() as i32
    }

    fn width(&self, s: &str, size: f64) -> f64 {
        let units: u32 = s
            .chars()
            .filter(|c| !c.is_control())
            .map(|c| u32::from(self.advance(self.glyph(c))))
            .sum();
        f64::from(units) * size / f64::from(self.units_per_em)
    }

    fn ascent_pt(&self, size: f64) -> f64 {
        f64::from(self.ascent) * size / f64::from(self.units_per_em)
    }
}

struct FontUse {
    name: String,
    ttf: Ttf,
    /// glyph đã dùng → ký tự (cho `ToUnicode`).
    used: BTreeMap<u16, char>,
}

/// Bộ dựng PDF: thêm phông, trang, chữ, hình rồi [`PdfBuilder::finish`].
pub struct PdfBuilder {
    title: String,
    author: String,
    fonts: Vec<FontUse>,
    pages: Vec<String>,
    texts: Vec<String>,
}

fn rgb_parts(rgb: u32) -> (f64, f64, f64) {
    (
        f64::from((rgb >> 16) & 0xFF) / 255.0,
        f64::from((rgb >> 8) & 0xFF) / 255.0,
        f64::from(rgb & 0xFF) / 255.0,
    )
}

fn utf16_hex(s: &str) -> String {
    let mut out = String::from("FEFF");
    for u in s.encode_utf16() {
        let _ = write!(out, "{u:04X}");
    }
    out
}

fn put(out: &mut Vec<u8>, offsets: &mut Vec<usize>, body: &[u8]) {
    offsets.push(out.len());
    out.extend_from_slice(format!("{} 0 obj\n", offsets.len()).as_bytes());
    out.extend_from_slice(body);
    out.extend_from_slice(b"\nendobj\n");
}

fn stream(dict: &str, data: &[u8]) -> Vec<u8> {
    let mut v = format!("<< {dict} /Length {} >>\nstream\n", data.len()).into_bytes();
    v.extend_from_slice(data);
    v.extend_from_slice(b"\nendstream");
    v
}

impl PdfBuilder {
    /// Tài liệu một trang trống.
    pub fn new(title: &str, author: &str) -> Self {
        Self {
            title: title.to_owned(),
            author: author.to_owned(),
            fonts: Vec::new(),
            pages: vec![String::new()],
            texts: Vec::new(),
        }
    }

    /// Nhúng một phông; trả chỉ số dùng cho các hàm vẽ chữ.
    pub fn add_font(&mut self, name: &str, data: &'static [u8]) -> Result<usize, PdfError> {
        let ttf = Ttf::parse(data)?;
        let name: String = name.chars().filter(char::is_ascii_alphanumeric).collect();
        self.fonts.push(FontUse {
            name,
            ttf,
            used: BTreeMap::new(),
        });
        Ok(self.fonts.len() - 1)
    }

    pub fn add_page(&mut self) {
        self.pages.push(String::new());
    }

    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    /// Mọi chuỗi đã vẽ theo thứ tự (để kiểm nội dung văn bản mà không cần đọc lại PDF).
    pub fn texts(&self) -> &[String] {
        &self.texts
    }

    /// Bề rộng chuỗi (point).
    pub fn text_width(&self, font: usize, size: f64, s: &str) -> f64 {
        self.fonts.get(font).map_or(0.0, |f| f.ttf.width(s, size))
    }

    /// Vẽ một dòng chữ với mép trên ở `y_top`; ký tự điều khiển bị bỏ.
    pub fn text(&mut self, font: usize, size: f64, rgb: u32, x: f64, y_top: f64, s: &str) {
        let Some(f) = self.fonts.get_mut(font) else {
            return;
        };
        let mut hex = String::new();
        for ch in s.chars().filter(|c| !c.is_control()) {
            let gid = f.ttf.glyph(ch);
            if gid != 0 {
                f.used.entry(gid).or_insert(ch);
            }
            let _ = write!(hex, "{gid:04X}");
        }
        if hex.is_empty() {
            return;
        }
        self.texts.push(s.to_owned());
        let base = PAGE_H - y_top - f.ttf.ascent_pt(size);
        let (r, g, b) = rgb_parts(rgb);
        if let Some(page) = self.pages.last_mut() {
            let _ = writeln!(
                page,
                "BT /F{font} {size:.2} Tf {r:.3} {g:.3} {b:.3} rg 1 0 0 1 {x:.2} {base:.2} Tm <{hex}> Tj ET"
            );
        }
    }

    /// Chữ căn phải: mép phải ở `right`.
    pub fn text_right(&mut self, font: usize, size: f64, rgb: u32, right: f64, y_top: f64, s: &str) {
        let w = self.text_width(font, size, s);
        self.text(font, size, rgb, right - w, y_top, s);
    }

    /// Chữ căn giữa trong vùng `[x, x + width]`.
    #[allow(clippy::too_many_arguments)]
    pub fn text_center(&mut self, font: usize, size: f64, rgb: u32, x: f64, width: f64, y_top: f64, s: &str) {
        let w = self.text_width(font, size, s);
        self.text(font, size, rgb, x + (width - w) / 2.0, y_top, s);
    }

    /// Đoạn chữ tự xuống dòng theo bề rộng (cắt ở dấu cách; `\n` xuống dòng cứng); trả tổng chiều cao đã dùng.
    #[allow(clippy::too_many_arguments)]
    pub fn text_wrapped(
        &mut self,
        font: usize,
        size: f64,
        rgb: u32,
        x: f64,
        y_top: f64,
        width: f64,
        line_height: f64,
        s: &str,
    ) -> f64 {
        let mut y = y_top;
        for para in s.split('\n') {
            let mut line = String::new();
            for word in para.split(' ') {
                if line.is_empty() {
                    line = word.to_owned();
                    continue;
                }
                let candidate = format!("{line} {word}");
                if self.text_width(font, size, &candidate) > width {
                    self.text(font, size, rgb, x, y, &line);
                    y += line_height;
                    line = word.to_owned();
                } else {
                    line = candidate;
                }
            }
            self.text(font, size, rgb, x, y, &line);
            y += line_height;
        }
        y - y_top
    }

    /// Hình chữ nhật tô màu.
    pub fn fill_rect(&mut self, x: f64, y_top: f64, w: f64, h: f64, rgb: u32) {
        let (r, g, b) = rgb_parts(rgb);
        let y = PAGE_H - y_top - h;
        if let Some(page) = self.pages.last_mut() {
            let _ = writeln!(
                page,
                "{r:.3} {g:.3} {b:.3} rg {x:.2} {y:.2} {w:.2} {h:.2} re f"
            );
        }
    }

    /// Đường thẳng.
    pub fn line(&mut self, x1: f64, y1_top: f64, x2: f64, y2_top: f64, rgb: u32, width: f64) {
        let (r, g, b) = rgb_parts(rgb);
        let (y1, y2) = (PAGE_H - y1_top, PAGE_H - y2_top);
        if let Some(page) = self.pages.last_mut() {
            let _ = writeln!(
                page,
                "{r:.3} {g:.3} {b:.3} RG {width:.2} w {x1:.2} {y1:.2} m {x2:.2} {y2:.2} l S"
            );
        }
    }

    /// Ghép tệp PDF hoàn chỉnh.
    pub fn finish(self) -> Vec<u8> {
        let nf = self.fonts.len();
        let first_page = 4 + 5 * nf;
        let mut out: Vec<u8> = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
        let mut offsets: Vec<usize> = Vec::new();

        put(&mut out, &mut offsets, b"<< /Type /Catalog /Pages 2 0 R >>");
        let kids: String = (0..self.pages.len())
            .map(|k| format!("{} 0 R", first_page + 2 * k))
            .collect::<Vec<_>>()
            .join(" ");
        put(
            &mut out,
            &mut offsets,
            format!("<< /Type /Pages /Count {} /Kids [{kids}] >>", self.pages.len()).as_bytes(),
        );
        put(
            &mut out,
            &mut offsets,
            format!(
                "<< /Title <{}> /Author <{}> /Producer (Trinity CRM) >>",
                utf16_hex(&self.title),
                utf16_hex(&self.author)
            )
            .as_bytes(),
        );

        for (i, f) in self.fonts.iter().enumerate() {
            let base = 4 + 5 * i;
            let name = &f.name;
            put(
                &mut out,
                &mut offsets,
                format!(
                    "<< /Type /Font /Subtype /Type0 /BaseFont /{name} /Encoding /Identity-H \
                     /DescendantFonts [{} 0 R] /ToUnicode {} 0 R >>",
                    base + 1,
                    base + 4
                )
                .as_bytes(),
            );
            let mut widths = String::new();
            for gid in f.used.keys() {
                let w = f.ttf.per_mille(i32::from(f.ttf.advance(*gid)));
                let _ = write!(widths, "{gid} [{w}] ");
            }
            put(
                &mut out,
                &mut offsets,
                format!(
                    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{name} \
                     /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> \
                     /FontDescriptor {} 0 R /DW 1000 /W [{widths}] /CIDToGIDMap /Identity >>",
                    base + 2
                )
                .as_bytes(),
            );
            let t = &f.ttf;
            put(
                &mut out,
                &mut offsets,
                format!(
                    "<< /Type /FontDescriptor /FontName /{name} /Flags 32 /FontBBox [{} {} {} {}] /ItalicAngle 0 \
                     /Ascent {} /Descent {} /CapHeight {} /StemV 80 /FontFile2 {} 0 R >>",
                    t.per_mille(i32::from(t.bbox[0])),
                    t.per_mille(i32::from(t.bbox[1])),
                    t.per_mille(i32::from(t.bbox[2])),
                    t.per_mille(i32::from(t.bbox[3])),
                    t.per_mille(i32::from(t.ascent)),
                    t.per_mille(i32::from(t.descent)),
                    t.per_mille(i32::from(t.ascent)),
                    base + 3
                )
                .as_bytes(),
            );
            put(
                &mut out,
                &mut offsets,
                &stream(&format!("/Length1 {}", t.data.len()), t.data),
            );
            put(
                &mut out,
                &mut offsets,
                &stream("", to_unicode(&f.used).as_bytes()),
            );
        }

        let resources: String = (0..nf)
            .map(|i| format!("/F{i} {} 0 R", 4 + 5 * i))
            .collect::<Vec<_>>()
            .join(" ");
        for (k, content) in self.pages.iter().enumerate() {
            put(
                &mut out,
                &mut offsets,
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] \
                     /Resources << /Font << {resources} >> >> /Contents {} 0 R >>",
                    first_page + 2 * k + 1
                )
                .as_bytes(),
            );
            put(&mut out, &mut offsets, &stream("", content.as_bytes()));
        }

        let xref_at = out.len();
        let mut xref = format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len() + 1);
        for o in &offsets {
            let _ = writeln!(xref, "{o:010} 00000 n ");
        }
        xref.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R /Info 3 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
            offsets.len() + 1
        ));
        out.extend_from_slice(xref.as_bytes());
        out
    }
}

/// CMap `ToUnicode`: glyph → ký tự (UTF-16BE), tối đa 100 dòng mỗi khối `bfchar`.
fn to_unicode(used: &BTreeMap<u16, char>) -> String {
    let mut s = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n\
         /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
         /CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n\
         1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
    );
    let entries: Vec<(&u16, &char)> = used.iter().collect();
    for chunk in entries.chunks(100) {
        let _ = writeln!(s, "{} beginbfchar", chunk.len());
        for (gid, ch) in chunk {
            let mut buf = [0_u16; 2];
            let units: String = ch.encode_utf16(&mut buf).iter().map(|u| format!("{u:04X}")).collect();
            let _ = writeln!(s, "<{gid:04X}> <{units}>");
        }
        s.push_str("endbfchar\n");
    }
    s.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> (PdfBuilder, usize) {
        let mut d = PdfBuilder::new("Phiếu lương - 2026-03", "Công ty");
        let f = d.add_font("Tinos", TINOS_REGULAR).unwrap();
        (d, f)
    }

    #[test]
    fn phong_co_chu_viet_va_do_rong() {
        let (d, f) = doc();
        for c in "ăâêôơưđ ếềểễệ ạảãá ỳỷỹỵ ĐỖ".chars().filter(|c| *c != ' ') {
            assert_ne!(d.fonts[f].ttf.glyph(c), 0, "thiếu glyph {c}");
        }
        assert!(d.text_width(f, 10.0, "Họ tên") > 0.0);
        assert!(d.text_width(f, 10.0, "Họ tên Nguyễn") > d.text_width(f, 10.0, "Họ tên"));
    }

    #[test]
    fn tep_pdf_hop_le_va_co_tounicode() {
        let (mut d, f) = doc();
        d.text(f, 12.0, 0, 40.0, 40.0, "Thực nhận: 15.000.000");
        d.fill_rect(40.0, 60.0, 100.0, 19.0, 0xE7F3E0);
        d.line(40.0, 90.0, 555.0, 90.0, 0x999999, 1.0);
        d.add_page();
        d.text(f, 12.0, 0, 40.0, 40.0, "Trang 2");
        assert_eq!(d.page_count(), 2);
        assert_eq!(d.texts(), ["Thực nhận: 15.000.000", "Trang 2"]);
        let bytes = d.finish();
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.starts_with("%PDF-1.7"));
        assert!(s.trim_end().ends_with("%%EOF"));
        assert!(s.contains("/Count 2"));
        assert!(s.contains("/Subtype /Type0"));
        assert!(s.contains("beginbfchar"));
        // ự = U+1EF1 phải có trong bảng ToUnicode.
        assert!(s.contains("<1EF1>"));
    }

    #[test]
    fn xuong_dong_theo_be_rong() {
        let (mut d, f) = doc();
        let h = d.text_wrapped(
            f,
            9.0,
            0,
            40.0,
            40.0,
            60.0,
            10.0,
            "một hai ba bốn năm sáu bảy tám chín mười\nhết",
        );
        assert!(h > 20.0);
        assert!(d.texts().len() > 2);
        assert_eq!(d.texts().last().map(String::as_str), Some("hết"));
    }
}
