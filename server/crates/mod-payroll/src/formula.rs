//! Kiểm công thức của bảng lương: bản chuyển của `validateFormula` (`salary-rules/formula-evaluator.ts`).
//!
//! Bản TS làm ba việc: chỉ cho định danh `base`, `achievement_rate`, `revenue` và hàm `min|max|abs|floor|ceil`; chỉ cho
//! ký tự `[A-Za-z0-9_+\-*/(),.\s]`; rồi BIÊN DỊCH (không chạy) `"use strict"; return (<công thức>);` bằng `new
//! Function` để bắt lỗi cú pháp. Bước cuối ở đây là một bộ phân tích cú pháp biểu thức JS cho đúng tập ký tự đó (strict
//! mode): `+ - * / **`, một ngôi `+ -`, `++`/`--` tiền tố và hậu tố, dấu phẩy, gọi hàm (kể cả `...` và dấu phẩy cuối),
//! truy cập `.tên`, số thập phân, chú thích `//` và `/* */`.
//!
//! Khác biệt đã biết: hằng regex (`/ /`) ở vị trí toán hạng bị từ chối; Node nhận nhưng kết quả là `NaN` nên công thức vô
//! dụng. Việc TÍNH công thức thuộc M30a.

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
    Num,
    Ident,
    Op(&'static str),
    LParen,
    RParen,
    Comma,
    Dot,
    Spread,
}

/// Token kèm cờ "có xuống dòng ngay trước nó".
struct Lexed {
    tok: Tok,
    nl_before: bool,
}

fn lex(src: &str) -> Option<Vec<Lexed>> {
    let cs: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let (mut i, mut nl) = (0, false);
    while i < cs.len() {
        let c = cs[i];
        if is_ws(c) {
            nl |= is_lt(c);
            i += 1;
        } else if c == '/' && cs.get(i + 1) == Some(&'/') {
            // Chú thích dòng: phải có xuống dòng kết thúc, vì phần `);` do `new Function` thêm vào nằm sau công thức.
            let end = (i..cs.len()).find(|&k| is_lt(cs[k]))?;
            i = end;
        } else if c == '/' && cs.get(i + 1) == Some(&'*') {
            let end = (i + 2..cs.len().saturating_sub(1)).find(|&k| cs[k] == '*' && cs[k + 1] == '/')?;
            nl |= cs[i..end].iter().any(|&c| is_lt(c));
            i = end + 2;
        } else if c.is_ascii_digit() || (c == '.' && cs.get(i + 1).is_some_and(char::is_ascii_digit)) {
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
            out.push(Lexed {
                tok: Tok::Num,
                nl_before: std::mem::take(&mut nl),
            });
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
                tok: Tok::Ident,
                nl_before: std::mem::take(&mut nl),
            });
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
            out.push(Lexed {
                tok,
                nl_before: std::mem::take(&mut nl),
            });
        }
    }
    Some(out)
}

struct Parser {
    toks: Vec<Lexed>,
    pos: usize,
}

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

    /// Expression: `a, b, c`.
    fn comma(&mut self) -> Option<()> {
        self.add()?;
        while self.eat(&Tok::Comma) {
            self.add()?;
        }
        Some(())
    }

    fn add(&mut self) -> Option<()> {
        self.mul()?;
        while self.is_op("+") || self.is_op("-") {
            self.pos += 1;
            self.mul()?;
        }
        Some(())
    }

    fn mul(&mut self) -> Option<()> {
        self.exp()?;
        while self.is_op("*") || self.is_op("/") {
            self.pos += 1;
            self.exp()?;
        }
        Some(())
    }

    /// `ExponentiationExpression`: vế trái của `**` không được là biểu thức một ngôi chưa bọc ngoặc.
    fn exp(&mut self) -> Option<()> {
        if self.is_op("+") || self.is_op("-") {
            self.pos += 1;
            self.unary_operand()?;
            return if self.is_op("**") { None } else { Some(()) };
        }
        self.update()?;
        if self.is_op("**") {
            self.pos += 1;
            self.exp()?;
        }
        Some(())
    }

    fn unary_operand(&mut self) -> Option<()> {
        if self.is_op("+") || self.is_op("-") {
            self.pos += 1;
            return self.unary_operand();
        }
        self.update()
    }

    fn update(&mut self) -> Option<()> {
        if self.is_op("++") || self.is_op("--") {
            self.pos += 1;
            return self.lhs().map(|_| ());
        }
        let target = self.lhs()?;
        if self.is_op("++") || self.is_op("--") {
            if self.toks[self.pos].nl_before || !target {
                return None;
            }
            self.pos += 1;
        }
        Some(())
    }

    /// Biểu thức vế trái; trả về "có phải đích gán hợp lệ" (định danh, truy cập thuộc tính, ngoặc bọc đích, lời gọi).
    fn lhs(&mut self) -> Option<bool> {
        let mut target = match self.peek()? {
            Tok::Num => {
                self.pos += 1;
                false
            }
            Tok::Ident => {
                self.pos += 1;
                true
            }
            Tok::LParen => {
                self.pos += 1;
                let start = self.pos;
                self.comma()?;
                if !self.eat(&Tok::RParen) {
                    return None;
                }
                // `(a)` còn là đích gán; `(a, b)` hay `(1 + 2)` thì không. Đủ chính xác: chỉ coi là đích khi là một token.
                self.pos - start == 2 && matches!(self.toks[start].tok, Tok::Ident)
            }
            _ => return None,
        };
        loop {
            match self.peek() {
                Some(Tok::Dot) => {
                    self.pos += 1;
                    if !self.eat(&Tok::Ident) {
                        return None;
                    }
                    target = true;
                }
                Some(Tok::LParen) => {
                    self.pos += 1;
                    self.args()?;
                    target = true;
                }
                _ => return Some(target),
            }
        }
    }

    /// Đối số của lời gọi, sau `(`: rỗng, hoặc danh sách (có thể `...x`), cho phép dấu phẩy cuối.
    fn args(&mut self) -> Option<()> {
        loop {
            if self.eat(&Tok::RParen) {
                return Some(());
            }
            self.eat(&Tok::Spread);
            self.add()?;
            if !self.eat(&Tok::Comma) {
                return if self.eat(&Tok::RParen) { Some(()) } else { None };
            }
        }
    }
}

/// `validateFormula`: định danh/ký tự cho phép và cú pháp biểu thức hợp lệ.
pub fn validate_formula(formula: &str) -> bool {
    let Some(toks) = lex(formula) else { return false };
    let mut p = Parser { toks, pos: 0 };
    p.comma().is_some() && p.pos == p.toks.len()
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
            "base /* ghi chú */ + 1",
            "base // ghi chú\n + 1",
            "max(1, 2,)",
            "max()",
            "min.max",
            "(base, revenue)",
            "base\n+ 1",
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
            "base // ghi chú",
            "base /* chưa đóng",
            "base\n++ + 1",
            "base é",
            "base[0]",
            "`x`",
            "'a'",
            "a.b",
            "(/ /)",
        ] {
            assert!(!ok(f), "{f:?} phải bị từ chối");
        }
    }
}
