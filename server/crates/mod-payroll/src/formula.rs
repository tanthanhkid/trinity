//! Công thức của bảng lương: bản chuyển của `formula-evaluator.ts` (`validateFormula` và `evaluateFormula`).
//!
//! `validateFormula` của bản TS làm ba việc: chỉ cho định danh `base`, `achievement_rate`, `revenue` và hàm
//! `min|max|abs|floor|ceil`; chỉ cho ký tự `[A-Za-z0-9_+\-*/(),.\s]` (áp lên CHUỖI THÔ, kể cả trong chú thích); rồi BIÊN
//! DỊCH (không chạy) `"use strict"; return (<công thức>);` bằng `new Function` để bắt lỗi cú pháp. Bước cuối ở đây là một
//! bộ phân tích cú pháp biểu thức JS (strict) cho đúng tập ký tự đó: `+ - * / **`, một ngôi `+ -`, `++`/`--` tiền tố và hậu
//! tố, dấu phẩy, gọi hàm (kể cả `...` và dấu phẩy cuối), truy cập `.tên`, số thập phân, chú thích `//` và `/* */`.
//!
//! `evaluateFormula` tính cây cú pháp đó bằng số thực IEEE 754 như JS: kết quả không hữu hạn ⇒ lỗi, còn lại là
//! `BigInt(Math.max(0, Math.floor(x)))`. Giá trị trả về là số nguyên không âm biểu diễn bằng `f64` (chính xác, vì nó là
//! `floor` của một số thực; bên gọi đổi sang `i64` có kiểm tra tràn).
//!
//! Công thức được ghép vào `return (…);` nên ngoặc không cần cân bằng riêng (`1) + (2` hợp lệ); hằng regex ở vị trí toán
//! hạng cũng hợp lệ (kết quả `NaN`). Phép `+` với giá trị không phải số (hàm) ở JS ra chuỗi; ở đây ra một giá trị "chuỗi" mà mọi phép số học sau đó biến
//! thành `NaN`, nên kết quả cuối cùng (lỗi không hữu hạn) giống nhau. `obj.tên++` trên `Math.min`… (hàm) gán thuộc tính vào
//! chính đối tượng dùng chung của tiến trình Node, nên ở Node công thức đó làm LẦN SAU thấy `min.tên = NaN` thay vì `undefined`
//! (rò trạng thái); Rust mỗi lần tính một môi trường mới. Bảng ca so với lần chạy sạch.

use std::collections::HashMap;

const VARS: [&str; 3] = ["base", "achievement_rate", "revenue"];
const FUNCS: [&str; 5] = ["min", "max", "abs", "floor", "ceil"];

/// Khoảng trắng của `\s` trong JS (cũng là khoảng trắng ở mã nguồn JS).
fn is_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn is_lt(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn is_id_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_id_part(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Ident(String),
    Op(&'static str),
    LParen,
    RParen,
    Comma,
    Dot,
    Spread,
    /// Hằng regex `/…/`: ở JS là object, mọi phép số học trên nó cho `NaN`.
    Regex,
}

/// Token kèm cờ "có xuống dòng ngay trước nó".
struct Lexed {
    tok: Tok,
    nl_before: bool,
}

/// Trả về token và cờ "công thức kết thúc bằng chú thích dòng chưa xuống dòng" (nuốt luôn phần `);` do `new Function` thêm).
fn lex(src: &str) -> Option<(Vec<Lexed>, bool)> {
    let cs: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let (mut i, mut nl) = (0, false);
    // Token cuối có kết thúc một toán hạng không (quyết định `/` là chia hay mở hằng regex).
    let mut operand_end = false;
    let mut swallowed = false;
    while i < cs.len() {
        let c = cs[i];
        if is_ws(c) {
            nl |= is_lt(c);
            i += 1;
        } else if c == '/' && cs.get(i + 1) == Some(&'/') {
            // Chú thích dòng tới hết dòng; nếu hết chuỗi mà chưa xuống dòng thì nó nuốt cả `);` của phần bọc.
            match (i..cs.len()).find(|&k| is_lt(cs[k])) {
                Some(end) => i = end,
                None => {
                    swallowed = true;
                    i = cs.len();
                }
            }
        } else if c == '/' && cs.get(i + 1) == Some(&'*') {
            let end = (i + 2..cs.len().saturating_sub(1)).find(|&k| cs[k] == '*' && cs[k + 1] == '/')?;
            nl |= cs[i..end].iter().any(|&c| is_lt(c));
            i = end + 2;
        } else if c == '/' && !operand_end {
            // Vị trí toán hạng: `/` mở hằng regex, kết thúc ở `/` kế tiếp trên CÙNG dòng.
            let close = (i + 1..cs.len())
                .take_while(|&k| !is_lt(cs[k]))
                .find(|&k| cs[k] == '/')?;
            let body: String = cs[i + 1..close].iter().collect();
            if !regex_body_ok(&body) || cs.get(close + 1).is_some_and(|&c| is_id_part(c)) {
                return None; // mẫu sai hoặc cờ không hợp lệ
            }
            i = close + 1;
            out.push(Lexed {
                tok: Tok::Regex,
                nl_before: std::mem::take(&mut nl),
            });
            operand_end = true;
        } else if c.is_ascii_digit() || (c == '.' && cs.get(i + 1).is_some_and(char::is_ascii_digit)) {
            let start = i;
            if c == '0' && cs.get(i + 1).is_some_and(char::is_ascii_digit) {
                return None; // số bát phân kiểu cũ: lỗi ở strict mode
            }
            let digits = |i: &mut usize| {
                while cs.get(*i).is_some_and(char::is_ascii_digit) {
                    *i += 1;
                }
            };
            if c == '.' {
                i += 1;
                digits(&mut i);
            } else {
                digits(&mut i);
                if cs.get(i) == Some(&'.') {
                    i += 1;
                    digits(&mut i);
                }
            }
            if cs.get(i).is_some_and(|&c| is_id_start(c) || c.is_ascii_digit()) {
                return None; // định danh dính liền số
            }
            let text: String = cs[start..i].iter().collect();
            out.push(Lexed {
                tok: Tok::Num(text.parse().unwrap_or(f64::NAN)),
                nl_before: std::mem::take(&mut nl),
            });
            operand_end = true;
        } else if is_id_start(c) {
            let start = i;
            while cs.get(i).is_some_and(|&c| is_id_part(c)) {
                i += 1;
            }
            let w: String = cs[start..i].iter().collect();
            if !VARS.contains(&w.as_str()) && !FUNCS.contains(&w.as_str()) {
                return None;
            }
            out.push(Lexed {
                tok: Tok::Ident(w),
                nl_before: std::mem::take(&mut nl),
            });
            operand_end = true;
        } else {
            let two: String = cs[i..cs.len().min(i + 2)].iter().collect();
            let tok = match (c, two.as_str()) {
                ('.', _) if cs.get(i + 1) == Some(&'.') && cs.get(i + 2) == Some(&'.') => {
                    i += 2;
                    Tok::Spread
                }
                (_, "**") => {
                    i += 1;
                    Tok::Op("**")
                }
                (_, "++") => {
                    i += 1;
                    Tok::Op("++")
                }
                (_, "--") => {
                    i += 1;
                    Tok::Op("--")
                }
                ('+', _) => Tok::Op("+"),
                ('-', _) => Tok::Op("-"),
                ('*', _) => Tok::Op("*"),
                ('/', _) => Tok::Op("/"),
                ('(', _) => Tok::LParen,
                (')', _) => Tok::RParen,
                (',', _) => Tok::Comma,
                ('.', _) => Tok::Dot,
                _ => return None,
            };
            i += 1;
            // `)` và `++`/`--` hậu tố kết thúc một toán hạng; mọi token khác thì không.
            operand_end = match &tok {
                Tok::RParen => true,
                Tok::Op("++" | "--") => operand_end,
                _ => false,
            };
            out.push(Lexed {
                tok,
                nl_before: std::mem::take(&mut nl),
            });
        }
    }
    Some((out, swallowed))
}

/// Thân hằng regex hợp lệ với tập ký tự cho phép (không có `\\`, `[`, `{`, `|`, `?`): ngoặc cân bằng và lượng từ `*`/`+`
/// phải đứng sau một "nguyên tử" (không ở đầu, sau `(`, hay sau một lượng từ khác — V8 báo "nothing to repeat").
fn regex_body_ok(body: &str) -> bool {
    let (mut depth, mut atom) = (0_u32, false);
    for c in body.chars() {
        match c {
            '(' => {
                depth += 1;
                atom = false;
            }
            ')' => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
                atom = true;
            }
            '*' | '+' => {
                if !atom {
                    return false;
                }
                atom = false;
            }
            _ => atom = true,
        }
    }
    depth == 0 && !body.is_empty()
}

/// Cây cú pháp của biểu thức.
#[derive(Debug, Clone)]
enum Expr {
    Num(f64),
    Regex,
    Var(String),
    /// `x.tên`: tên thuộc tính luôn thuộc danh sách cho phép và không có trên số hay hàm ⇒ `undefined`.
    Member(Box<Expr>),
    Call(Box<Expr>, Vec<(bool, Expr)>),
    Neg(Box<Expr>),
    Pos(Box<Expr>),
    Bin(&'static str, Box<Expr>, Box<Expr>),
    Comma(Vec<Expr>),
    Update {
        prefix: bool,
        delta: f64,
        target: Box<Expr>,
    },
}

struct Parser {
    toks: Vec<Lexed>,
    pos: usize,
}

type P = Option<(Expr, bool)>;

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos).map(|t| &t.tok)
    }

    fn eat(&mut self, t: &Tok) -> bool {
        if self.peek() == Some(t) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn is_op(&self, op: &str) -> bool {
        matches!(self.peek(), Some(Tok::Op(o)) if *o == op)
    }

    /// Expression: `a, b, c`. Mọi hàm bên dưới trả về (cây, "có phải đích gán hợp lệ không"): chỉ định danh, truy cập thuộc
    /// tính, lời gọi và ngoặc bọc MỘT đích mới đúng; có toán tử là sai.
    fn comma(&mut self) -> P {
        let (first, mut t) = self.add()?;
        let mut all = vec![first];
        while self.eat(&Tok::Comma) {
            all.push(self.add()?.0);
            t = false;
        }
        if all.len() == 1 {
            Some((all.remove(0), t))
        } else {
            Some((Expr::Comma(all), false))
        }
    }

    fn add(&mut self) -> P {
        let (mut e, mut t) = self.mul()?;
        loop {
            let op = if self.is_op("+") {
                "+"
            } else if self.is_op("-") {
                "-"
            } else {
                return Some((e, t));
            };
            self.pos += 1;
            let r = self.mul()?.0;
            e = Expr::Bin(op, Box::new(e), Box::new(r));
            t = false;
        }
    }

    fn mul(&mut self) -> P {
        let (mut e, mut t) = self.exp()?;
        loop {
            let op = if self.is_op("*") {
                "*"
            } else if self.is_op("/") {
                "/"
            } else {
                return Some((e, t));
            };
            self.pos += 1;
            let r = self.exp()?.0;
            e = Expr::Bin(op, Box::new(e), Box::new(r));
            t = false;
        }
    }

    /// `ExponentiationExpression`: vế trái của `**` không được là biểu thức một ngôi chưa bọc ngoặc.
    fn exp(&mut self) -> P {
        if self.is_op("+") || self.is_op("-") {
            let neg = self.is_op("-");
            self.pos += 1;
            let (inner, _) = self.unary_operand()?;
            if self.is_op("**") {
                return None;
            }
            let e = if neg {
                Expr::Neg(Box::new(inner))
            } else {
                Expr::Pos(Box::new(inner))
            };
            return Some((e, false));
        }
        let (base, t) = self.update()?;
        if self.is_op("**") {
            self.pos += 1;
            let r = self.exp()?.0;
            return Some((Expr::Bin("**", Box::new(base), Box::new(r)), false));
        }
        Some((base, t))
    }

    fn unary_operand(&mut self) -> P {
        if self.is_op("+") || self.is_op("-") {
            let neg = self.is_op("-");
            self.pos += 1;
            let (inner, _) = self.unary_operand()?;
            let e = if neg {
                Expr::Neg(Box::new(inner))
            } else {
                Expr::Pos(Box::new(inner))
            };
            return Some((e, false));
        }
        self.update()
    }

    fn update(&mut self) -> P {
        if self.is_op("++") || self.is_op("--") {
            let delta = if self.is_op("++") { 1.0 } else { -1.0 };
            self.pos += 1;
            // Toán hạng của `++x`/`--x` phải là đích gán hợp lệ (`++1`, `--(a + b)` là lỗi cú pháp).
            let (target, ok) = self.lhs()?;
            return if ok {
                Some((
                    Expr::Update {
                        prefix: true,
                        delta,
                        target: Box::new(target),
                    },
                    false,
                ))
            } else {
                None
            };
        }
        let (e, target) = self.lhs()?;
        if self.is_op("++") || self.is_op("--") {
            if self.toks[self.pos].nl_before || !target {
                return None;
            }
            let delta = if self.is_op("++") { 1.0 } else { -1.0 };
            self.pos += 1;
            return Some((
                Expr::Update {
                    prefix: false,
                    delta,
                    target: Box::new(e),
                },
                false,
            ));
        }
        Some((e, target))
    }

    /// Biểu thức vế trái; trả về "có phải đích gán hợp lệ".
    fn lhs(&mut self) -> P {
        let (mut e, mut target) = match self.peek()?.clone() {
            Tok::Num(n) => {
                self.pos += 1;
                (Expr::Num(n), false)
            }
            Tok::Regex => {
                self.pos += 1;
                (Expr::Regex, false)
            }
            Tok::Ident(w) => {
                self.pos += 1;
                (Expr::Var(w), true)
            }
            Tok::LParen => {
                self.pos += 1;
                let (inner, t) = self.comma()?;
                if !self.eat(&Tok::RParen) {
                    return None;
                }
                (inner, t)
            }
            _ => return None,
        };
        loop {
            match self.peek() {
                Some(Tok::Dot) => {
                    self.pos += 1;
                    if !matches!(self.peek(), Some(Tok::Ident(_))) {
                        return None;
                    }
                    self.pos += 1;
                    e = Expr::Member(Box::new(e));
                    target = true;
                }
                Some(Tok::LParen) => {
                    self.pos += 1;
                    let args = self.args()?;
                    e = Expr::Call(Box::new(e), args);
                    target = true;
                }
                _ => return Some((e, target)),
            }
        }
    }

    /// Đối số của lời gọi, sau `(`: rỗng, hoặc danh sách (có thể `...x`), cho phép dấu phẩy cuối.
    fn args(&mut self) -> Option<Vec<(bool, Expr)>> {
        let mut out = Vec::new();
        loop {
            if self.eat(&Tok::RParen) {
                return Some(out);
            }
            let spread = self.eat(&Tok::Spread);
            out.push((spread, self.add()?.0));
            if !self.eat(&Tok::Comma) {
                return if self.eat(&Tok::RParen) { Some(out) } else { None };
            }
        }
    }
}

/// Bước 1 và 2 của `validateFormula` trên CHUỖI THÔ (kể cả trong chú thích): mọi định danh `[A-Za-z_][A-Za-z0-9_]*` phải
/// thuộc danh sách cho phép, và mọi ký tự phải thuộc `[A-Za-z0-9_+\-*/(),.\s]`.
fn whitelist_ok(src: &str) -> bool {
    let cs: Vec<char> = src.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if is_id_start(c) {
            let start = i;
            while cs.get(i).is_some_and(|&c| is_id_part(c)) {
                i += 1;
            }
            let w: String = cs[start..i].iter().collect();
            if !VARS.contains(&w.as_str()) && !FUNCS.contains(&w.as_str()) {
                return false;
            }
            continue;
        }
        if !(c.is_ascii_digit() || is_ws(c) || matches!(c, '+' | '-' | '*' | '/' | '(' | ')' | ',' | '.')) {
            return false;
        }
        i += 1;
    }
    true
}

fn parse(formula: &str) -> Option<Expr> {
    if !whitelist_ok(formula) {
        return None;
    }
    let (mut toks, swallowed) = lex(formula)?;
    // `new Function` biên dịch `return (<công thức>);`: công thức được GHÉP vào giữa cặp ngoặc đó, nên `1) + (2` hay
    // `floor ) ( ` cũng hợp lệ ở Node. Dựng lại đúng như vậy.
    toks.insert(
        0,
        Lexed {
            tok: Tok::LParen,
            nl_before: false,
        },
    );
    if !swallowed {
        toks.push(Lexed {
            tok: Tok::RParen,
            nl_before: false,
        });
    }
    let mut p = Parser { toks, pos: 0 };
    let (e, _) = p.comma()?;
    (p.pos == p.toks.len()).then_some(e)
}

/// `validateFormula`: định danh/ký tự cho phép (áp lên toàn chuỗi thô) rồi cú pháp biểu thức hợp lệ.
pub fn validate_formula(formula: &str) -> bool {
    parse(formula).is_some()
}

/// Biến đầu vào của công thức (`FormulaContext`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FormulaContext {
    pub base: f64,
    pub achievement_rate: f64,
    pub revenue: f64,
}

/// Lỗi của [`evaluate_formula`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormulaError {
    /// `validateFormula` từ chối ("Công thức không hợp lệ").
    Invalid,
    /// Kết quả `NaN`/vô cực, vd chia cho 0 ("Công thức cho kết quả không hợp lệ").
    NotFinite,
    /// Lỗi lúc chạy mà JS ném (gọi thứ không phải hàm, `...` trên số, gán vào lời gọi).
    Runtime,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Val {
    Num(f64),
    Func(&'static str),
    Undefined,
    /// Kết quả của `+` với một hàm hay regex: chuỗi ở JS; mọi phép số học sau đó cho `NaN`.
    Str,
    /// Hằng regex: object (gán được thuộc tính, không lặp được), số học trên nó cho `NaN`.
    Regex,
}

impl Val {
    fn num(self) -> f64 {
        match self {
            Val::Num(n) => n,
            _ => f64::NAN,
        }
    }
}

/// `Math.min`/`Math.max` với `NaN` lan truyền và `-0 < +0`.
fn extreme(args: &[f64], max: bool) -> f64 {
    let mut r = if max { f64::NEG_INFINITY } else { f64::INFINITY };
    for &a in args {
        if a.is_nan() {
            return f64::NAN;
        }
        let better = if max {
            a > r || (a == 0.0 && r == 0.0 && !a.is_sign_negative())
        } else {
            a < r || (a == 0.0 && r == 0.0 && a.is_sign_negative())
        };
        if better {
            r = a;
        }
    }
    r
}

/// `Math.pow` của JS: khác `f64::powf` ở `1 ** ±∞` và `1 ** NaN` (JS ra `NaN`).
fn js_pow(a: f64, b: f64) -> f64 {
    if b.is_nan() || (b.is_infinite() && a.abs() == 1.0) {
        return f64::NAN;
    }
    a.powf(b)
}

struct Eval {
    env: HashMap<String, Val>,
}

impl Eval {
    fn call(name: &str, args: &[f64]) -> f64 {
        let first = args.first().copied().unwrap_or(f64::NAN);
        match name {
            "min" => extreme(args, false),
            "max" => extreme(args, true),
            "abs" => first.abs(),
            "floor" => first.floor(),
            _ => first.ceil(),
        }
    }

    fn eval(&mut self, e: &Expr) -> Result<Val, FormulaError> {
        Ok(match e {
            Expr::Num(n) => Val::Num(*n),
            Expr::Regex => Val::Regex,
            Expr::Var(name) => self.env.get(name).copied().unwrap_or(Val::Undefined),
            Expr::Member(obj) => {
                // Đọc thuộc tính của `undefined` là TypeError; của số, chuỗi, hàm, regex thì ra `undefined` (mọi tên cho phép
                // đều không có trên các kiểu đó).
                if self.eval(obj)? == Val::Undefined {
                    return Err(FormulaError::Runtime);
                }
                Val::Undefined
            }
            Expr::Call(callee, args) => {
                let f = self.eval(callee)?;
                let mut vals = Vec::new();
                for (spread, a) in args {
                    let v = self.eval(a)?;
                    if *spread {
                        match v {
                            // Chuỗi lặp được theo ký tự; chuỗi ở đây luôn bắt đầu bằng ký tự không phải số (`function…`, `/…`) nên
                            // ký tự đầu là `NaN`: `floor/ceil/abs` lấy ký tự đầu, `min/max` gặp `NaN` đều ra `NaN`.
                            Val::Str => vals.push(f64::NAN),
                            // Số, hàm, regex, `undefined` không lặp được: TypeError.
                            _ => return Err(FormulaError::Runtime),
                        }
                        continue;
                    }
                    vals.push(v.num());
                }
                match f {
                    Val::Func(name) => Val::Num(Self::call(name, &vals)),
                    _ => return Err(FormulaError::Runtime),
                }
            }
            Expr::Neg(x) => Val::Num(-self.eval(x)?.num()),
            Expr::Pos(x) => Val::Num(self.eval(x)?.num()),
            Expr::Comma(all) => {
                let mut last = Val::Undefined;
                for x in all {
                    last = self.eval(x)?;
                }
                last
            }
            Expr::Update { prefix, delta, target } => match &**target {
                Expr::Var(name) => {
                    let old = self.env.get(name).copied().unwrap_or(Val::Undefined).num();
                    let new = old + delta;
                    self.env.insert(name.clone(), Val::Num(new));
                    Val::Num(if *prefix { new } else { old })
                }
                // `obj.tên++`: đọc ra `undefined` ⇒ `NaN`. Gán thuộc tính vào object (hàm, regex) thành công ở strict mode nên
                // kết quả là `NaN`; vào số, chuỗi, `undefined` (nguyên thuỷ) thì TypeError.
                Expr::Member(obj) => match self.eval(obj)? {
                    Val::Func(_) | Val::Regex => Val::Num(f64::NAN),
                    _ => return Err(FormulaError::Runtime),
                },
                // Gán vào kết quả lời gọi: lỗi lúc chạy.
                _ => {
                    self.eval(target)?;
                    return Err(FormulaError::Runtime);
                }
            },
            Expr::Bin(op, l, r) => {
                let a = self.eval(l)?;
                let b = self.eval(r)?;
                if *op == "+"
                    && (matches!(a, Val::Func(_) | Val::Str | Val::Regex)
                        || matches!(b, Val::Func(_) | Val::Str | Val::Regex))
                {
                    return Ok(Val::Str);
                }
                let (x, y) = (a.num(), b.num());
                Val::Num(match *op {
                    "+" => x + y,
                    "-" => x - y,
                    "*" => x * y,
                    "/" => x / y,
                    _ => js_pow(x, y),
                })
            }
        })
    }
}

/// `evaluateFormula`: công thức không hợp lệ ⇒ [`FormulaError::Invalid`]; kết quả không hữu hạn ⇒
/// [`FormulaError::NotFinite`]; còn lại `Math.max(0, Math.floor(x))` (số nguyên không âm, kiểu `f64`).
pub fn evaluate_formula(formula: &str, ctx: FormulaContext) -> Result<f64, FormulaError> {
    let ast = parse(formula).ok_or(FormulaError::Invalid)?;
    let mut env: HashMap<String, Val> = HashMap::new();
    env.insert("base".into(), Val::Num(ctx.base));
    env.insert("achievement_rate".into(), Val::Num(ctx.achievement_rate));
    env.insert("revenue".into(), Val::Num(ctx.revenue));
    for f in FUNCS {
        env.insert(f.into(), Val::Func(f));
    }
    let result = Eval { env }.eval(&ast)?.num();
    if !result.is_finite() {
        return Err(FormulaError::NotFinite);
    }
    Ok(result.floor().max(0.0) + 0.0)
}

#[cfg(test)]
mod tests {
    use super::validate_formula as ok;

    #[test]
    fn cong_thuc_hop_le() {
        for f in [
            "7000000",
            "base * achievement_rate / 100",
            "revenue * 0.005",
            "max(0, (achievement_rate - 100) * base * 0.01)",
            "min(base, revenue)",
            "floor(base / 3)",
            "abs(-5)",
            ".5 * base",
            "5. * base",
            "-base",
            "- -base",
            "2 ** 3",
            "2 ** -1",
            "(-2) ** 2",
            "base ++ + 1",
            "base /* base */ + 1",
            "base // base\n + 1",
            "max(1, 2,)",
            "max()",
            "min.max",
            "(base, revenue)",
            "base\n+ 1",
            "((base))++",
            "++(base)",
            "++base.max",
            "-++base",
            "min) // / ..-- 1000000",
            "(/ /)",
            "1 /2/ 3",
            "/0.01revenue/",
            "1) + (2",
            "floor ) ( ",
            "base * /(1)*/",
        ] {
            assert!(ok(f), "{f:?} phải hợp lệ");
        }
    }

    #[test]
    fn cong_thuc_sai() {
        for f in [
            "",
            "   ",
            "base *",
            "* base",
            "base base",
            "(base",
            "base)",
            "/*/",
            "/+/",
            "/a/",
            "/(/",
            "/ /g",
            "foo * 2",
            "base2",
            "1e5",
            "0x10",
            "5base",
            "base % 2",
            "base > 1",
            "base ? 1 : 2",
            "base; 1",
            "base = 1",
            "1 ++",
            "-2 ** 2",
            "010",
            "1.5.2",
            "1..2",
            "max(1,,2)",
            "(base,)",
            "base // base",
            "base /* base",
            "base\n++ + 1",
            "base é",
            "base[0]",
            "`x`",
            "'a'",
            "a.b",
            "base /* x */",
            "base // é\n + 1",
            "base /* é */",
            "++1",
            "--(base + 1)",
            "++(1)",
            "(base + 1)++",
            "(base, base)++",
            "++(base, base)",
        ] {
            assert!(!ok(f), "{f:?} phải bị từ chối");
        }
    }
}
