//! Tìm tệp trong thư mục bản xuất tĩnh (`out/` của `next build` với `output: 'export'`).
//!
//! Route động (R004, phương án A): bản xuất chỉ có trang giữ chỗ cho mỗi đoạn động, đặt tên thư mục/tệp là `_`
//! (`contacts/_.html`, `contacts/_/__next._tree.txt`). Khi một đoạn không có tên khớp, tìm bằng `_`. Bảng luật vì vậy
//! **đọc từ cấu trúc thư mục** do chính lần build sinh ra, không viết tay.

use std::path::{Path, PathBuf};

/// Tên đoạn giữ chỗ.
const PLACEHOLDER: &str = "_";

/// Kho tệp tĩnh trên đĩa.
#[derive(Debug, Clone)]
pub struct WebAssets {
    root: PathBuf,
}

impl WebAssets {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Tìm tệp cho đường dẫn URL (đã bỏ query). Trả `None` khi không có hoặc đường dẫn không an toàn.
    ///
    /// Thứ tự cho đoạn cuối: tệp đúng tên, `<tên>.html`, `<tên>/index.html`; mỗi bước thử tên thật trước rồi tới `_`.
    /// Đoạn giữa thử thư mục tên thật trước rồi tới `_` (có quay lui).
    pub fn find(&self, url_path: &str) -> Option<PathBuf> {
        let mut segs: Vec<String> = Vec::new();
        for raw in url_path.split('/').filter(|s| !s.is_empty()) {
            let s = percent_decode(raw)?;
            if s == "." || s == ".." || s.contains(['/', '\\', '\0']) {
                return None;
            }
            segs.push(s);
        }
        find_in(&self.root, &segs)
    }

    /// Trang 404 do Next xuất (`404.html`), nếu có.
    pub fn not_found_page(&self) -> Option<PathBuf> {
        let p = self.root.join("404.html");
        p.is_file().then_some(p)
    }
}

fn find_in(dir: &Path, segs: &[String]) -> Option<PathBuf> {
    let Some((first, rest)) = segs.split_first() else {
        let index = dir.join("index.html");
        return index.is_file().then_some(index);
    };
    let names: [&str; 2] = [first.as_str(), PLACEHOLDER];
    let tried = if first == PLACEHOLDER { 1 } else { 2 };
    for name in &names[..tried] {
        if rest.is_empty() {
            let file = dir.join(name);
            if file.is_file() {
                return Some(file);
            }
            let html = dir.join(format!("{name}.html"));
            if html.is_file() {
                return Some(html);
            }
            let index = dir.join(name).join("index.html");
            if index.is_file() {
                return Some(index);
            }
        } else {
            let sub = dir.join(name);
            if sub.is_dir()
                && let Some(found) = find_in(&sub, rest)
            {
                return Some(found);
            }
        }
    }
    None
}

/// Giải mã `%XX`. `None` khi sai cú pháp hoặc không phải UTF-8.
fn percent_decode(s: &str) -> Option<String> {
    if !s.contains('%') {
        return Some(s.to_owned());
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `Content-Type` theo đuôi tệp.
pub fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "mp4" => "video/mp4",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> (PathBuf, WebAssets) {
        let name = format!(
            "trinity-web-assets-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        );
        let dir = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&dir);
        for f in [
            "index.html",
            "404.html",
            "login.html",
            "contacts.html",
            "contacts/_.html",
            "contacts/_/__next._tree.txt",
            "contacts/_/__next.contacts.$d$id.__PAGE__.txt",
            "x/_.html",
            "x/_/new.html",
            "x/_/_.html",
            "x/_/v/_.html",
            "s/_.html",
            "settings/index.html",
            "_next/static/chunks/a.js",
        ] {
            let p = dir.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, f).unwrap();
        }
        (dir.clone(), WebAssets::new(dir))
    }

    fn rel(a: &WebAssets, url: &str) -> Option<String> {
        a.find(url)
            .map(|p| p.strip_prefix(a.root()).unwrap().to_string_lossy().replace('\\', "/"))
    }

    #[test]
    fn tim_tep_theo_luat_giu_cho() {
        let (dir, a) = tree();
        let cases = [
            ("/", Some("index.html")),
            ("/login", Some("login.html")),
            ("/settings", Some("settings/index.html")),
            ("/contacts", Some("contacts.html")),
            ("/contacts/123", Some("contacts/_.html")),
            ("/contacts/123/__next._tree.txt", Some("contacts/_/__next._tree.txt")),
            (
                "/contacts/123/__next.contacts.$d$id.__PAGE__.txt",
                Some("contacts/_/__next.contacts.$d$id.__PAGE__.txt"),
            ),
            ("/x/person", Some("x/_.html")),
            ("/x/person/new", Some("x/_/new.html")),
            ("/x/person/99", Some("x/_/_.html")),
            ("/x/person/v/board", Some("x/_/v/_.html")),
            ("/s/cua-hang", Some("s/_.html")),
            ("/_next/static/chunks/a.js", Some("_next/static/chunks/a.js")),
            ("/khong-co", None),
            ("/_next/static/chunks/b.js", None),
        ];
        for (url, want) in cases {
            assert_eq!(rel(&a, url).as_deref(), want, "{url}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn duong_dan_khong_an_toan_bi_tu_choi() {
        let (dir, a) = tree();
        for url in [
            "/../etc/passwd",
            "/contacts/../../x",
            "/%2e%2e/x",
            "/a%2Fb",
            "/a%5Cb",
            "/a%00b",
            "/%zz",
            "/%ff",
        ] {
            assert_eq!(a.find(url), None, "{url}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn content_type_theo_duoi() {
        assert_eq!(content_type(Path::new("a/b.html")), "text/html; charset=utf-8");
        assert_eq!(content_type(Path::new("a.JS")), "text/javascript; charset=utf-8");
        assert_eq!(content_type(Path::new("__next._tree.txt")), "text/plain; charset=utf-8");
        assert_eq!(content_type(Path::new("noext")), "application/octet-stream");
    }
}
