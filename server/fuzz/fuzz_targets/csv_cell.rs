//! Bộ ghi ô CSV (`csv_cell`, chống chèn công thức) kiểm bằng bộ đọc tối thiểu viết ngay ở đây.
//! Hiện Rust chưa có bộ đọc CSV nhập (PLAN 6.3 ghi "bộ đọc CSV"); khi có thì thêm target cho nó, giữ target này.
//! Bất biến: đọc ngược ô ra đúng chuỗi gốc (có thêm `'` đầu nếu bắt đầu bằng `= + - @ tab CR`); không bao giờ để ô
//! bắt đầu bằng ký tự công thức sau khi bỏ ngoặc kép.
#![no_main]

use libfuzzer_sys::fuzz_target;
use mod_custom::export::csv_cell;
use serde_json::Value;

const LEAD: [char; 6] = ['=', '+', '-', '@', '\t', '\r'];

fn unquote(cell: &str) -> String {
    match cell.strip_prefix('"').and_then(|c| c.strip_suffix('"')) {
        Some(inner) if cell.len() >= 2 => inner.replace("\"\"", "\""),
        _ => cell.to_owned(),
    }
}

fuzz_target!(|s: String| {
    let cell = csv_cell(&Value::String(s.clone()));
    let back = unquote(&cell);
    let expected = if s.starts_with(LEAD) { format!("'{s}") } else { s };
    assert_eq!(back, expected);
    assert!(!back.starts_with(LEAD), "ô bắt đầu bằng ký tự công thức");
    // Ô không ngoặc kép thì không được chứa ký tự tách ô/dòng.
    if !cell.starts_with('"') {
        assert!(!cell.contains([',', '\n', '\r', '"']));
    }
});
