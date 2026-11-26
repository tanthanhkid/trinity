//! Công thức của trường `formula` (bảng tuỳ biến, M57): bộ phân tích + thẩm định kiểu + tính TỰ VIẾT, không `eval`.
//! Chuyển từ `services/crm/src/custom-objects/formula/formula-parser.ts`; câu lỗi tiếng Việt giữ nguyên văn và kết quả
//! khớp bản TS qua bảng ca dùng chung `server/contracts/cases/formula.json` (TS sinh, Rust chạy ở `tests/formula_cases.rs`).
//!
//! Cú pháp: số (`12`, `3.5`), tham chiếu `{ten_truong}`, `+ - * /`, dấu trừ đơn ngôi, `round(x, n)` (n nguyên 0..6 viết
//! thẳng), `months_between(d1, d2)`, `days_between(d1, d2)`. Thiếu giá trị hoặc chia cho 0 → kết quả `None`.
//!
//! Ký tự lạ ngoài BMP (emoji…) báo lỗi nguyên ký tự; bản TS đã sửa cùng cách (trước đây báo nửa cặp surrogate).
//!
//! Điểm khác bản TS (không có trong bảng ca): chuỗi ngày giờ có chữ `T` mà không có múi giờ (`2025-01-01T10:00`) bản TS
//! hiểu theo múi giờ của tiến trình Node (UTC trên máy chủ), Rust hiểu là UTC; dạng không phải ISO 8601 mà `Date.parse`
//! của V8 vẫn nhận (ví dụ `Tue Jan 01 2025 T`) Rust coi là không đọc được → `None`.

use std::collections::BTreeSet;
use std::fmt;

use crate::number::js_round;

/// Lỗi phân tích/thẩm định; nội dung là câu tiếng Việt trả về cho người dùng (HTTP 400).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormulaError(pub String);

impl fmt::Display for FormulaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FormulaError {}

fn err<T>(msg: impl Into<String>) -> Result<T, FormulaError> {
    Err(FormulaError(msg.into()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Add,
    Sub,
    Mul,
    Div,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormulaFn {
    Round,
    MonthsBetween,
    DaysBetween,
}

impl FormulaFn {
    fn name(self) -> &'static str {
        match self {
            Self::Round => "round",
            Self::MonthsBetween => "months_between",
            Self::DaysBetween => "days_between",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Num(f64),
    Ref(String),
    Neg(Box<Node>),
    Bin(Op, Box<Node>, Box<Node>),
    Call(FormulaFn, Vec<Node>),
}

pub const MAX_LENGTH: usize = 300;
pub const MAX_NODES: usize = 100;
pub const MAX_DEPTH: usize = 20;

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Ref(String),
    Fn(String),
    Op(Op),
    Lp,
    Rp,
    Comma,
}

/// `String.prototype.trim` của JS: WhiteSpace + LineTerminator của ECMAScript = `White_Space` của Unicode trừ `U+0085`
/// (NEL), cộng BOM (`U+FEFF`).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

fn valid_ref_key(k: &str) -> bool {
    let b = k.as_bytes();
    (1..=48).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

fn tokenize(src: &str) -> Result<Vec<Tok>, FormulaError> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if matches!(c, ' ' | '\t' | '\n' | '\r') {
            i += 1;
        } else if c.is_ascii_digit() {
            let mut j = i;
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
            if chars.get(j) == Some(&'.') {
                j += 1;
                let start_frac = j;
                while j < chars.len() && chars[j].is_ascii_digit() {
                    j += 1;
                }
                if j == start_frac {
                    return err("Số thập phân không hợp lệ (thiếu chữ số sau dấu chấm)");
                }
            }
            let text: String = chars[i..j].iter().collect();
            // Chuỗi chỉ gồm chữ số và một dấu chấm: `parse` ra đúng số gần nhất như `Number(...)`, tràn → ∞.
            out.push(Tok::Num(text.parse::<f64>().unwrap_or(f64::NAN)));
            i = j;
        } else if c == '{' {
            let Some(rel) = chars[i..].iter().position(|&x| x == '}') else {
                return err("Thiếu dấu } đóng tham chiếu trường");
            };
            let end = i + rel;
            let raw: String = chars[i + 1..end].iter().collect();
            let key = js_trim(&raw);
            if !valid_ref_key(key) {
                let shown: String = key.chars().take(30).collect();
                return err(format!("Tên trường tham chiếu không hợp lệ: {{{shown}}}"));
            }
            out.push(Tok::Ref(key.to_owned()));
            i = end + 1;
        } else if c.is_ascii_lowercase() {
            let mut j = i;
            while j < chars.len() && (chars[j].is_ascii_lowercase() || chars[j] == '_') {
                j += 1;
            }
            out.push(Tok::Fn(chars[i..j].iter().collect()));
            i = j;
        } else {
            out.push(match c {
                '+' => Tok::Op(Op::Add),
                '-' => Tok::Op(Op::Sub),
                '*' => Tok::Op(Op::Mul),
                '/' => Tok::Op(Op::Div),
                '(' => Tok::Lp,
                ')' => Tok::Rp,
                ',' => Tok::Comma,
                other => return err(format!("Ký tự không được phép trong công thức: \"{other}\"")),
            });
            i += 1;
        }
    }
    Ok(out)
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
    nodes: usize,
}

impl Parser {
    fn parse(&mut self) -> Result<Node, FormulaError> {
        if self.toks.is_empty() {
            return err("Công thức đang trống");
        }
        let n = self.expr(0)?;
        if self.pos < self.toks.len() {
            return err("Công thức thừa ký tự ở cuối");
        }
        Ok(n)
    }

    fn bump(&mut self) -> Result<(), FormulaError> {
        self.nodes += 1;
        if self.nodes > MAX_NODES {
            err("Công thức quá dài/phức tạp")
        } else {
            Ok(())
        }
    }

    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }

    fn binary_op(&self, ops: [Op; 2]) -> Option<Op> {
        match self.peek() {
            Some(Tok::Op(o)) if ops.contains(o) => Some(*o),
            _ => None,
        }
    }

    fn expr(&mut self, depth: usize) -> Result<Node, FormulaError> {
        if depth > MAX_DEPTH {
            return err("Công thức lồng quá sâu");
        }
        let mut left = self.term(depth)?;
        while let Some(op) = self.binary_op([Op::Add, Op::Sub]) {
            self.pos += 1;
            let right = self.term(depth)?;
            self.bump()?;
            left = Node::Bin(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn term(&mut self, depth: usize) -> Result<Node, FormulaError> {
        let mut left = self.unary(depth)?;
        while let Some(op) = self.binary_op([Op::Mul, Op::Div]) {
            self.pos += 1;
            let right = self.unary(depth)?;
            self.bump()?;
            left = Node::Bin(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn unary(&mut self, depth: usize) -> Result<Node, FormulaError> {
        if depth > MAX_DEPTH {
            return err("Công thức lồng quá sâu");
        }
        if self.peek() == Some(&Tok::Op(Op::Sub)) {
            self.pos += 1;
            self.bump()?;
            return Ok(Node::Neg(Box::new(self.unary(depth + 1)?)));
        }
        self.primary(depth)
    }

    fn primary(&mut self, depth: usize) -> Result<Node, FormulaError> {
        let Some(t) = self.peek().cloned() else {
            return err("Công thức chưa hoàn chỉnh");
        };
        self.pos += 1;
        self.bump()?;
        match t {
            Tok::Num(v) => Ok(Node::Num(v)),
            Tok::Ref(key) => Ok(Node::Ref(key)),
            Tok::Lp => {
                let inner = self.expr(depth + 1)?;
                self.expect_rp()?;
                Ok(inner)
            }
            Tok::Fn(name) => self.call(&name, depth),
            _ => err("Công thức sai cú pháp"),
        }
    }

    fn call(&mut self, name: &str, depth: usize) -> Result<Node, FormulaError> {
        let f = match name {
            "round" => FormulaFn::Round,
            "months_between" => FormulaFn::MonthsBetween,
            "days_between" => FormulaFn::DaysBetween,
            _ => return err(format!("Hàm không được hỗ trợ: {name}")),
        };
        if self.peek() != Some(&Tok::Lp) {
            return err(format!("Thiếu dấu ( sau hàm {name}"));
        }
        self.pos += 1;
        let mut args = vec![self.expr(depth + 1)?];
        while self.peek() == Some(&Tok::Comma) {
            self.pos += 1;
            args.push(self.expr(depth + 1)?);
        }
        self.expect_rp()?;
        if args.len() != 2 {
            return err(format!("Hàm {name} cần đúng 2 đối số"));
        }
        Ok(Node::Call(f, args))
    }

    fn expect_rp(&mut self) -> Result<(), FormulaError> {
        if self.peek() != Some(&Tok::Rp) {
            return err("Thiếu dấu ) đóng");
        }
        self.pos += 1;
        Ok(())
    }
}

/// Phân tích cú pháp. Độ dài tính theo đơn vị UTF-16 như `String.length` của JS.
pub fn parse_formula(expression: &str) -> Result<Node, FormulaError> {
    if expression.encode_utf16().count() > MAX_LENGTH {
        return err(format!("Công thức tối đa {MAX_LENGTH} ký tự"));
    }
    Parser {
        toks: tokenize(expression)?,
        pos: 0,
        nodes: 0,
    }
    .parse()
}

/// Mọi khoá trường được tham chiếu (không trùng, đã sắp).
pub fn collect_refs(node: &Node) -> BTreeSet<String> {
    fn walk(node: &Node, out: &mut BTreeSet<String>) {
        match node {
            Node::Ref(k) => {
                out.insert(k.clone());
            }
            Node::Neg(a) => walk(a, out),
            Node::Bin(_, a, b) => {
                walk(a, out);
                walk(b, out);
            }
            Node::Call(_, args) => args.iter().for_each(|a| walk(a, out)),
            Node::Num(_) => {}
        }
    }
    let mut out = BTreeSet::new();
    walk(node, &mut out);
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefKind {
    Num,
    Date,
}

/// Thẩm định kiểu: số học chỉ trên số; hàm ngày chỉ nhận tham chiếu ngày; `round` nhận biểu thức số + số nguyên 0..6
/// viết thẳng; kết quả cuối phải là số. `ref_kind(key)` trả `None` nếu trường không tồn tại / không được tham chiếu.
pub fn check_formula(node: &Node, ref_kind: &dyn Fn(&str) -> Option<RefKind>) -> Result<(), FormulaError> {
    if type_of(node, ref_kind)? != RefKind::Num {
        return err("Kết quả công thức phải là số (dùng months_between/days_between cho ngày)");
    }
    Ok(())
}

fn type_of(node: &Node, ref_kind: &dyn Fn(&str) -> Option<RefKind>) -> Result<RefKind, FormulaError> {
    match node {
        Node::Num(_) => Ok(RefKind::Num),
        Node::Ref(key) => ref_kind(key).map_or_else(
            || {
                err(format!(
                    "Trường {{{key}}} không tồn tại hoặc không dùng được trong công thức (chỉ số, tiền, %, ngày)"
                ))
            },
            Ok,
        ),
        Node::Neg(a) => {
            if type_of(a, ref_kind)? != RefKind::Num {
                return err("Không thể đổi dấu một ngày");
            }
            Ok(RefKind::Num)
        }
        Node::Bin(_, a, b) => {
            if type_of(a, ref_kind)? != RefKind::Num || type_of(b, ref_kind)? != RefKind::Num {
                return err("Phép + − × ÷ chỉ dùng với số; dùng months_between/days_between để so sánh ngày");
            }
            Ok(RefKind::Num)
        }
        Node::Call(f, args) => call_type(*f, args, ref_kind),
    }
}

fn call_type(f: FormulaFn, args: &[Node], ref_kind: &dyn Fn(&str) -> Option<RefKind>) -> Result<RefKind, FormulaError> {
    let [a, b] = args else {
        return err(format!("Hàm {} cần đúng 2 đối số", f.name()));
    };
    if f == FormulaFn::Round {
        if type_of(a, ref_kind)? != RefKind::Num {
            return err("round(x, n): x phải là số");
        }
        match b {
            Node::Num(v) if v.fract() == 0.0 && (0.0..=6.0).contains(v) => return Ok(RefKind::Num),
            _ => return err("round(x, n): n phải là số nguyên từ 0 đến 6 viết thẳng"),
        }
    }
    let both_dates = matches!((a, b), (Node::Ref(_), Node::Ref(_)))
        && type_of(a, ref_kind)? == RefKind::Date
        && type_of(b, ref_kind)? == RefKind::Date;
    if !both_dates {
        let n = f.name();
        return err(format!(
            "{n}(d1, d2): cả hai đối số phải là trường ngày, ví dụ {n}({{bat_dau}}, {{ket_thuc}})"
        ));
    }
    Ok(RefKind::Num)
}

/// Giá trị trường khi tính: số (percent ĐÃ chia 100), chuỗi ngày, hoặc thiếu.
#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Num(f64),
    Str(String),
}

/// Ngày lịch Việt Nam (UTC+7) của một chuỗi ngày/ngày giờ; như `parseYmd` của bản TS.
fn parse_ymd(v: &str) -> Option<(i64, i64, i64)> {
    let s = if v.contains('T') {
        let ms = parse_iso_ms(v)?;
        let (y, m, d) = civil_from_days((ms + 7 * 3_600_000).div_euclid(86_400_000));
        if !(0..=9999).contains(&y) {
            return None; // toISOString ra năm 5–6 chữ số hoặc âm: regex `\d{4}-` của bản TS không khớp
        }
        format!("{y:04}-{m:02}-{d:02}")
    } else {
        v.to_owned()
    };
    // Regex `^(\d{4})-(\d{2})-(\d{2})` (không kiểm giá trị tháng/ngày, không cần hết chuỗi).
    let b = s.as_bytes();
    let digits = |r: std::ops::Range<usize>| b.get(r).filter(|x| x.iter().all(u8::is_ascii_digit));
    let num = |r: std::ops::Range<usize>| digits(r).map(|x| x.iter().fold(0i64, |a, d| a * 10 + i64::from(d - b'0')));
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    Some((num(0..4)?, num(5..7)?, num(8..10)?))
}

/// Ngày từ 1970-01-01 của (năm, tháng, ngày) lịch Gregory, tháng/ngày có thể tràn như `Date.UTC`.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y + (m - 1).div_euclid(12);
    let m = (m - 1).rem_euclid(12) + 1;
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468 + (d - 1)
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `Date.parse` cho dạng ISO 8601 `YYYY-MM-DDTHH:mm[:ss[.f+]][Z|±HH:mm|±HHmm]` (cả năm mở rộng ±YYYYYY), luật miền giá
/// trị như V8: tháng 1–12, ngày 1–31 (ngày 31 của tháng 30 ngày tràn sang tháng sau), giờ 0–23 (24:00:00 được), phút/giây
/// 0–59. Trả mili giây UTC; không có múi giờ → UTC.
fn parse_iso_ms(v: &str) -> Option<i64> {
    let b = v.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize, n: usize| -> Option<i64> {
        let part = b.get(*i..*i + n)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        *i += n;
        Some(part.iter().fold(0i64, |a, d| a * 10 + i64::from(d - b'0')))
    };
    let year = match b.first()? {
        b'+' | b'-' => {
            let neg = b[0] == b'-';
            i = 1;
            let y = digits(&mut i, 6)?;
            if neg && y == 0 {
                return None;
            }
            if neg { -y } else { y }
        }
        _ => digits(&mut i, 4)?,
    };
    let lit = |i: &mut usize, c: u8| -> Option<()> { (b.get(*i) == Some(&c)).then(|| *i += 1) };
    // Dạng ngắn của V8: `YYYYTHH:mm…`, `YYYY-MMTHH:mm…` (tháng/ngày mặc định 1).
    let (mut month, mut day) = (1, 1);
    if lit(&mut i, b'-').is_some() {
        month = digits(&mut i, 2)?;
        if lit(&mut i, b'-').is_some() {
            day = digits(&mut i, 2)?;
        }
    }
    lit(&mut i, b'T').or_else(|| lit(&mut i, b't'))?;
    let hour = digits(&mut i, 2)?;
    lit(&mut i, b':')?;
    let min = digits(&mut i, 2)?;
    let (mut sec, mut frac_nonzero) = (0, false);
    if b.get(i) == Some(&b':') {
        i += 1;
        sec = digits(&mut i, 2)?;
        if b.get(i) == Some(&b'.') {
            i += 1;
            let start = i;
            while b.get(i).is_some_and(u8::is_ascii_digit) {
                frac_nonzero |= b[i] != b'0';
                i += 1;
            }
            if i == start {
                return None;
            }
        }
    }
    let mut offset_min = 0;
    match b.get(i) {
        None => {}
        Some(b'Z' | b'z') => i += 1,
        Some(&s @ (b'+' | b'-')) => {
            i += 1;
            let oh = digits(&mut i, 2)?;
            if b.get(i) == Some(&b':') {
                i += 1;
            }
            let om = digits(&mut i, 2)?;
            if oh > 23 || om > 59 {
                return None;
            }
            offset_min = (oh * 60 + om) * if s == b'+' { 1 } else { -1 };
        }
        _ => return None,
    }
    if i != b.len() || !(1..=12).contains(&month) || !(1..=31).contains(&day) || min > 59 || sec > 59 {
        return None;
    }
    if hour > 24 || (hour == 24 && (min != 0 || sec != 0 || frac_nonzero)) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(days * 86_400_000 + ((hour * 60 + min) * 60 + sec) * 1000 - offset_min * 60_000)
}

fn clean(x: f64) -> Option<f64> {
    if !x.is_finite() || x.abs() > 1e15 {
        return None;
    }
    Some(js_round(x * 1e6) / 1e6)
}

/// `round(x, n)` của công thức: nửa xa số 0 theo cách của bản TS (`Math.round(|x|·f + EPSILON·f) / f`).
fn round_formula(x: f64, n: f64) -> f64 {
    let f = 10f64.powf(n);
    let r = js_round(x.abs() * f + f64::EPSILON * f) / f;
    if x < 0.0 { -r } else { r }
}

/// `Date.UTC(y, m - 1, d)` tính bằng ngày, kể cả quy tắc năm 0–99 → 1900–1999.
fn utc_days(y: i64, m: i64, d: i64) -> i64 {
    days_from_civil(if (0..=99).contains(&y) { 1900 + y } else { y }, m, d)
}

fn eval_node(node: &Node, get: &dyn Fn(&str) -> Option<Val>) -> Option<Val> {
    match node {
        Node::Num(v) => Some(Val::Num(*v)),
        Node::Ref(k) => get(k),
        Node::Neg(a) => match eval_node(a, get)? {
            Val::Num(x) => Some(Val::Num(-x)),
            Val::Str(_) => None,
        },
        Node::Bin(op, a, b) => {
            let (Some(Val::Num(x)), Some(Val::Num(y))) = (eval_node(a, get), eval_node(b, get)) else {
                return None;
            };
            Some(Val::Num(match op {
                Op::Add => x + y,
                Op::Sub => x - y,
                Op::Mul => x * y,
                Op::Div if y == 0.0 => return None,
                Op::Div => x / y,
            }))
        }
        Node::Call(f, args) => {
            let [a, b] = args.as_slice() else {
                return None;
            };
            let a = eval_node(a, get);
            let b = eval_node(b, get);
            if *f == FormulaFn::Round {
                return match (a, b) {
                    (Some(Val::Num(x)), Some(Val::Num(n))) => Some(Val::Num(round_formula(x, n))),
                    _ => None,
                };
            }
            let (Some(Val::Str(a)), Some(Val::Str(b))) = (a, b) else {
                return None;
            };
            let ((y1, m1, d1), (y2, m2, d2)) = (parse_ymd(&a)?, parse_ymd(&b)?);
            Some(Val::Num(if *f == FormulaFn::MonthsBetween {
                ((y2 - y1) * 12 + (m2 - m1)) as f64 + (d2 - d1) as f64 / 30.0
            } else {
                (utc_days(y2, m2, d2) - utc_days(y1, m1, d1)) as f64
            }))
        }
    }
}

/// Tính công thức. `get(key)` trả số (percent đã chia 100) / chuỗi ngày / `None`. Kết quả `None` khi thiếu dữ liệu, chia
/// cho 0 hoặc ngoài phạm vi an toàn (|x| > 1e15); không báo lỗi lúc đọc. Chuẩn hoá 6 chữ số thập phân.
pub fn evaluate_formula(node: &Node, get: &dyn Fn(&str) -> Option<Val>) -> Option<f64> {
    match eval_node(node, get)? {
        Val::Num(x) => clean(x),
        Val::Str(_) => None,
    }
}
