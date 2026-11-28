//! SMTP giả cho test (#675): nghe trên `127.0.0.1:<cổng ngẫu nhiên>`, nói đủ EHLO/MAIL/RCPT/DATA/QUIT (không TLS, không
//! AUTH), giữ nguyên văn mọi thư nhận được. Dùng với `SMTP_SECURITY=none` để chạy luồng gửi mail thật qua `lettre` mà
//! không có thư nào ra ngoài.

use std::sync::{Arc, Mutex};

use base64::Engine;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

/// Một thư SMTP giả đã nhận.
#[derive(Debug, Clone)]
pub struct Received {
    pub from: String,
    pub to: Vec<String>,
    pub raw: String,
}

impl Received {
    /// Phần thân đã giải mã (base64 / quoted-printable) của mọi phần MIME, nối lại.
    pub fn decoded_text(&self) -> String {
        decode_parts(&self.raw)
    }

    /// Giá trị header (dòng đầu, không gộp dòng gập).
    pub fn header(&self, name: &str) -> Option<String> {
        let head = self.raw.split("\r\n\r\n").next().unwrap_or("");
        let prefix = format!("{}:", name.to_ascii_lowercase());
        head.lines()
            .find(|l| l.to_ascii_lowercase().starts_with(&prefix))
            .map(|l| l[prefix.len()..].trim().to_owned())
    }
}

/// Máy chủ SMTP giả; dừng khi `FakeSmtp` bị drop.
pub struct FakeSmtp {
    pub port: u16,
    pub inbox: Arc<Mutex<Vec<Received>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FakeSmtp {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeSmtp {
    pub async fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let inbox: Arc<Mutex<Vec<Received>>> = Arc::default();
        let store = inbox.clone();
        let task = tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let store = store.clone();
                tokio::spawn(async move {
                    let _ = session(sock, store).await;
                });
            }
        });
        Ok(Self { port, inbox, task })
    }

    pub fn take(&self) -> Vec<Received> {
        std::mem::take(&mut *self.inbox.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    /// Chờ tới khi có ít nhất `n` thư (tối đa ~5 giây).
    pub async fn wait_for(&self, n: usize) -> Vec<Received> {
        for _ in 0..100 {
            if self
                .inbox
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .len()
                >= n
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        self.take()
    }
}

async fn session(sock: tokio::net::TcpStream, store: Arc<Mutex<Vec<Received>>>) -> std::io::Result<()> {
    let (r, mut w) = sock.into_split();
    let mut r = BufReader::new(r);
    w.write_all(b"220 fake-smtp ESMTP\r\n").await?;
    let mut from = String::new();
    let mut to = Vec::new();
    let mut line = String::new();
    loop {
        line.clear();
        if r.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let cmd = line.trim_end().to_owned();
        let upper = cmd.to_ascii_uppercase();
        if upper.starts_with("EHLO") || upper.starts_with("HELO") {
            w.write_all(b"250-fake-smtp\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n")
                .await?;
        } else if upper.starts_with("MAIL FROM:") {
            from = cmd[10..]
                .trim()
                .trim_matches(['<', '>'])
                .split(' ')
                .next()
                .unwrap_or("")
                .to_owned();
            to.clear();
            w.write_all(b"250 OK\r\n").await?;
        } else if upper.starts_with("RCPT TO:") {
            to.push(cmd[8..].trim().trim_matches(['<', '>']).to_owned());
            w.write_all(b"250 OK\r\n").await?;
        } else if upper == "DATA" {
            w.write_all(b"354 go\r\n").await?;
            let mut raw = String::new();
            loop {
                line.clear();
                if r.read_line(&mut line).await? == 0 {
                    return Ok(());
                }
                if line == ".\r\n" || line == ".\n" {
                    break;
                }
                // Bỏ dấu chấm nhân đôi (dot-stuffing).
                raw.push_str(
                    line.strip_prefix('.')
                        .filter(|_| line.starts_with(".."))
                        .unwrap_or(&line),
                );
            }
            store
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(Received {
                    from: from.clone(),
                    to: to.clone(),
                    raw,
                });
            w.write_all(b"250 queued\r\n").await?;
        } else if upper == "QUIT" {
            w.write_all(b"221 bye\r\n").await?;
            return Ok(());
        } else {
            // RSET, NOOP…
            w.write_all(b"250 OK\r\n").await?;
        }
    }
}

fn decode_qp(s: &str) -> String {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'=' {
            if b.get(i + 1) == Some(&b'\r') && b.get(i + 2) == Some(&b'\n') {
                i += 3;
                continue;
            }
            if b.get(i + 1) == Some(&b'\n') {
                i += 2;
                continue;
            }
            if let Some(h) = s.get(i + 1..i + 3)
                && let Ok(v) = u8::from_str_radix(h, 16)
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn decode_parts(raw: &str) -> String {
    let mut out = String::new();
    for part in raw.split("\r\n--") {
        let mut it = part.splitn(2, "\r\n\r\n");
        let (Some(head), Some(body)) = (it.next(), it.next()) else {
            continue;
        };
        let head_l = head.to_ascii_lowercase();
        let body = body.split("\r\n--").next().unwrap_or(body);
        if head_l.contains("content-transfer-encoding: base64") {
            let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(compact) {
                out.push_str(&String::from_utf8_lossy(&bytes));
            }
        } else if head_l.contains("content-transfer-encoding: quoted-printable") {
            out.push_str(&decode_qp(body));
        } else if head_l.contains("content-type: text/") {
            out.push_str(body);
        }
        out.push('\n');
    }
    out
}
