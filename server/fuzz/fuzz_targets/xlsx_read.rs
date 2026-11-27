//! Bộ đọc xlsx của tệp người dùng tải lên (`trinity_docgen::xlsx::read_xlsx`, dùng ở các chỗ nhập). Bất biến: không panic,
//! không treo, không cấp phát vô hạn trên zip bom (thời gian/bộ nhớ do libFuzzer `-rss_limit_mb`, `-timeout` chặn).
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = trinity_docgen::xlsx::read_xlsx(data);
});
