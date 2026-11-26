//! Bảng sở hữu route nạp lại được: tệp (`TRINITY_OWNERSHIP_FILE`) + `SIGHUP`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use trinity_kernel::ownership::{Ownership, OwnershipError};

/// Bảng đang dùng. Đọc là lấy một `Arc` rồi bỏ khoá, nên request đang chạy không bị ảnh hưởng khi bảng đổi.
pub struct OwnershipTable {
    current: RwLock<Arc<Ownership>>,
    path: Option<PathBuf>,
}

impl OwnershipTable {
    /// Dựng bảng lúc khởi động. `path` (`TRINITY_OWNERSHIP_FILE`) luôn được giữ để `reload` nạp khi tệp xuất hiện.
    /// Tệp có và hợp lệ: dùng tệp. Tệp CHƯA có: bắt đầu với `initial` (từ `TRINITY_RUST_ROUTES`, hoặc mặc định mọi thứ thuộc
    /// Node), không lỗi. Tệp có mà hỏng hoặc không đọc được vì lý do khác: lỗi (binary không khởi động, như `check-config`).
    pub fn new(path: Option<&Path>, initial: Ownership) -> Result<Self, OwnershipError> {
        let current = match path {
            Some(p) => match Ownership::load(p) {
                Ok(own) => own,
                Err(e) if is_missing(&e) => initial,
                Err(e) => return Err(e),
            },
            None => initial,
        };
        Ok(Self {
            current: RwLock::new(Arc::new(current)),
            path: path.map(Path::to_owned),
        })
    }

    /// Tệp bắt buộc có lúc khởi động.
    pub fn from_file(path: &Path) -> Result<Self, OwnershipError> {
        let own = Ownership::load(path)?;
        Ok(Self {
            current: RwLock::new(Arc::new(own)),
            path: Some(path.to_owned()),
        })
    }

    /// Không có tệp: giá trị khởi tạo cố định. `reload` không làm gì.
    pub fn fixed(own: Ownership) -> Self {
        Self {
            current: RwLock::new(Arc::new(own)),
            path: None,
        }
    }

    pub fn current(&self) -> Arc<Ownership> {
        Arc::clone(&self.current.read().unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    /// Đọc lại tệp. Thành công: thay bảng (nguyên tử), trả `Ok(true)`. Tệp hỏng hoặc không đọc được: GIỮ bảng cũ, ghi lỗi,
    /// trả `Err`. Không có tệp (bảng cố định): `Ok(false)`.
    pub fn reload(&self) -> Result<bool, OwnershipError> {
        let Some(path) = &self.path else { return Ok(false) };
        match Ownership::load(path) {
            // Tệp chưa có (hoặc vừa bị xoá): giữ bảng đang dùng, không phải lỗi; có tệp thì lần nạp sau lấy.
            Err(e) if is_missing(&e) => {
                tracing::debug!("[ownership] chưa có tệp {}, giữ bảng hiện tại", path.display());
                Ok(false)
            }
            Ok(new) => {
                let mut cur = self.current.write().unwrap_or_else(std::sync::PoisonError::into_inner);
                if **cur != new {
                    tracing::info!("[ownership] đã nạp lại {}", path.display());
                }
                *cur = Arc::new(new);
                Ok(true)
            }
            Err(e) => {
                tracing::error!("[ownership] nạp lại lỗi, giữ bảng cũ: {e}");
                Err(e)
            }
        }
    }
}

fn is_missing(e: &OwnershipError) -> bool {
    matches!(e, OwnershipError::Io { source, .. } if source.kind() == std::io::ErrorKind::NotFound)
}

/// `TRINITY_RUST_ROUTES` làm giá trị khởi tạo: danh sách tiền tố cách nhau bằng dấu phẩy hoặc khoảng trắng, mỗi tiền tố
/// thuộc Rust (mọi phương thức). Rỗng hoặc thiếu ⇒ mọi route thuộc Node.
pub fn initial_from_routes_env(raw: Option<&str>) -> Result<Ownership, OwnershipError> {
    let prefixes: Vec<&str> = raw
        .unwrap_or("")
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .collect();
    let routes: Vec<serde_json::Value> = prefixes
        .iter()
        .map(|p| serde_json::json!({ "prefix": p, "owner": "rust" }))
        .collect();
    Ownership::parse(
        &serde_json::json!({ "routes": routes }).to_string(),
        "TRINITY_RUST_ROUTES",
    )
}

/// Nạp lại bảng mỗi lần nhận `SIGHUP`. Trả tác vụ nền (huỷ khi tắt máy).
#[cfg(unix)]
pub fn spawn_sighup_reloader(table: Arc<OwnershipTable>) -> std::io::Result<tokio::task::JoinHandle<()>> {
    use tokio::signal::unix::{SignalKind, signal};
    // Cài trình bắt TRƯỚC khi trả về: tín hiệu tới sau đó không giết tiến trình.
    let mut hup = signal(SignalKind::hangup())?;
    Ok(tokio::spawn(async move {
        while hup.recv().await.is_some() {
            // Lỗi đã được ghi trong `reload`; bảng cũ vẫn dùng.
            let _ = table.reload();
        }
    }))
}

#[cfg(not(unix))]
pub fn spawn_sighup_reloader(_table: Arc<OwnershipTable>) -> std::io::Result<tokio::task::JoinHandle<()>> {
    Ok(tokio::spawn(std::future::pending()))
}
