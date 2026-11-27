//! Nối shadow K28 vào `trinity serve` và lệnh `trinity shadow-report` (PLAN 4.14, 6.5).
//!
//! `SHADOW_SAMPLE_RATE` > 0 ⇒ `serve` dựng [`Shadow`] từ `routes.json` nhúng và cứ 60 giây ghi báo cáo ra tệp
//! (`SHADOW_REPORT_FILE`, mặc định `./shadow-report.json`, ghi qua tệp tạm rồi đổi tên). `trinity shadow-report` đọc tệp đó
//! và in theo route: số mẫu so với `min_samples`, đếm giống/khác, đường dẫn JSON khác biệt. Báo cáo KHÔNG chứa giá trị dữ liệu
//! (chỉ route, số đếm, đường dẫn JSON, lý do "không shadow được"). Bộ đếm nằm trong bộ nhớ của tiến trình `serve`: khởi động
//! lại thì đếm lại từ 0 (`since_unix` cho biết cửa sổ đo bắt đầu từ lúc nào).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use clap::Args;
use serde_json::{Value, json};
use trinity_http::router::check::CONTRACT;
use trinity_http::strangler::{Shadow, ShadowConfig, ShadowRoutes};
use trinity_kernel::config::process_env;

const DEFAULT_FILE: &str = "shadow-report.json";
const DUMP_EVERY: Duration = Duration::from_secs(60);
/// Báo cáo cũ hơn ngưỡng này (giây) thì `shadow-report` cảnh báo `serve` có thể đã dừng.
const STALE_SECS: u64 = 300;

#[derive(Debug, Args)]
pub struct ShadowReportArgs {
    /// Tệp báo cáo (mặc định: `SHADOW_REPORT_FILE`, rồi `./shadow-report.json`).
    #[arg(long)]
    file: Option<PathBuf>,
    /// In JSON nguyên bản thay vì bảng chữ.
    #[arg(long)]
    json: bool,
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn file_from_env(get: &impl Fn(&str) -> Option<String>) -> PathBuf {
    get("SHADOW_REPORT_FILE")
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .map_or_else(|| PathBuf::from(DEFAULT_FILE), PathBuf::from)
}

/// Dựng shadow cho `serve`. Tỉ lệ 0 (mặc định) ⇒ `None`, không làm gì thêm. Có `Some` thì đã chạy sẵn tác vụ ghi báo cáo.
pub fn init(get: impl Fn(&str) -> Option<String>) -> Result<Option<Arc<Shadow>>, String> {
    let cfg = ShadowConfig::from_lookup(&get);
    if cfg.sample_rate <= 0.0 {
        return Ok(None);
    }
    let rate = cfg.sample_rate;
    let routes = ShadowRoutes::from_contract(CONTRACT)?;
    let shadow = Shadow::new(cfg, routes);
    let path = file_from_env(&get);
    tracing::info!("shadow K28 bật: tỉ lệ {rate}, báo cáo ghi ra {}", path.display());
    spawn_dumper(shadow.clone(), path);
    Ok(Some(shadow))
}

fn spawn_dumper(shadow: Arc<Shadow>, path: PathBuf) {
    let since = unix_now();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(DUMP_EVERY);
        loop {
            tick.tick().await;
            let doc = document(&shadow.report(), since, unix_now());
            if let Err(e) = write_atomic(&path, &doc) {
                tracing::warn!("không ghi được báo cáo shadow: {e}");
            }
        }
    });
}

/// Báo cáo của [`Shadow`] kèm mốc thời gian (giây Unix).
fn document(report: &Value, since: u64, now: u64) -> Value {
    let mut doc = report.clone();
    if let Some(o) = doc.as_object_mut() {
        o.insert("since_unix".to_owned(), json!(since));
        o.insert("generated_unix".to_owned(), json!(now));
    }
    doc
}

fn write_atomic(path: &Path, doc: &Value) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

fn num(row: &Value, key: &str) -> u64 {
    row[key].as_u64().unwrap_or(0)
}

/// Bảng chữ và kết luận: `true` khi có route và mọi route đủ `min_samples`, không khác biệt, không "không shadow được".
fn render(doc: &Value, now: u64) -> (String, bool) {
    let rows: &[Value] = doc["routes"].as_array().map_or(&[], Vec::as_slice);
    let rate = doc["sample_rate"].as_f64().unwrap_or(0.0);
    let (since, generated) = (num(doc, "since_unix"), num(doc, "generated_unix"));
    let hours = generated.saturating_sub(since) as f64 / 3600.0;
    let mut lines = vec![format!(
        "shadow: tỉ lệ {rate}, cửa sổ đo {hours:.1} giờ (đếm lại từ 0 khi serve khởi động lại)"
    )];
    if now.saturating_sub(generated) > STALE_SECS {
        lines.push("cảnh báo: báo cáo đã cũ, `trinity serve` có thể đã dừng".to_owned());
    }
    let mut passed = 0usize;
    for row in rows {
        let reason = row["unshadowable"].as_str();
        let (samples, min) = (num(row, "samples"), num(row, "min_samples"));
        let (different, mismatch) = (num(row, "different"), num(row, "status_mismatch"));
        let ok = reason.is_none() && samples >= min && different == 0 && mismatch == 0;
        passed += usize::from(ok);
        lines.push(format!(
            "{} {}  mẫu {samples}/{min}  giống {}  khác {different}  lệch mã {mismatch}  bỏ {}{}",
            if ok { "OK" } else { "XX" },
            row["route"].as_str().unwrap_or("?"),
            num(row, "equal"),
            num(row, "skipped"),
            reason
                .map(|r| format!("  KHÔNG SHADOW ĐƯỢC: {r}"))
                .unwrap_or_default(),
        ));
        if let Some(paths) = row["diff_paths"].as_object() {
            for (p, n) in paths {
                lines.push(format!("    khác tại {p} x{n}"));
            }
        }
    }
    lines.push(format!("{passed}/{} route đạt", rows.len()));
    (lines.join("\n"), !rows.is_empty() && passed == rows.len())
}

/// `trinity shadow-report`: mã 0 khi mọi route đạt, mã 1 khi còn route chưa đạt, mã 2 khi không đọc được báo cáo.
pub fn run(args: ShadowReportArgs) -> ExitCode {
    let (env, _) = process_env();
    let path = args
        .file
        .unwrap_or_else(|| file_from_env(&|k: &str| env.get(k).cloned()));
    let doc = match std::fs::read_to_string(&path)
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()))
    {
        Ok(d) => d,
        Err(e) => {
            let _ = writeln!(
                std::io::stderr().lock(),
                "không đọc được báo cáo shadow {}: {e} (serve đã chạy với SHADOW_SAMPLE_RATE > 0 chưa?)",
                path.display()
            );
            return ExitCode::from(2);
        }
    };
    let (text, ready) = render(&doc, unix_now());
    let mut out = std::io::stdout().lock();
    if args.json {
        let _ = writeln!(out, "{}", serde_json::to_string_pretty(&doc).unwrap_or_default());
    } else {
        let _ = writeln!(out, "{text}");
    }
    if ready { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        json!({
            "sample_rate": 0.1,
            "routes": [
                {"route": "GET /a", "min_samples": 2, "samples": 3, "equal": 3, "different": 0, "status_mismatch": 0,
                 "skipped": 0, "unshadowable": null, "diff_paths": {}},
                {"route": "GET /b", "min_samples": 2, "samples": 2, "equal": 1, "different": 1, "status_mismatch": 0,
                 "skipped": 1, "unshadowable": null, "diff_paths": {"$.items[].name": 1}},
                {"route": "GET /c", "min_samples": 1, "samples": 0, "equal": 0, "different": 0, "status_mismatch": 0,
                 "skipped": 0, "unshadowable": "mạng: graph", "diff_paths": {}}
            ]
        })
    }

    #[test]
    fn bang_chu_liet_ke_route_va_ket_luan() {
        let doc = document(&sample(), 0, 7200);
        let (text, ready) = render(&doc, 7200);
        assert!(!ready);
        assert!(text.contains("OK GET /a"));
        assert!(text.contains("XX GET /b"));
        assert!(text.contains("khác tại $.items[].name x1"));
        assert!(text.contains("KHÔNG SHADOW ĐƯỢC: mạng: graph"));
        assert!(text.contains("1/3 route đạt"));
        assert!(text.contains("2.0 giờ"));
    }

    #[test]
    fn dat_khi_moi_route_du_mau_va_khong_khac() {
        let ok = json!({"sample_rate": 1.0, "routes": [sample()["routes"][0].clone()]});
        assert!(render(&document(&ok, 0, 10), 10).1);
        assert!(!render(&json!({"routes": []}), 0).1);
    }

    #[test]
    fn bao_cu_thi_canh_bao() {
        let doc = document(&sample(), 0, 100);
        assert!(render(&doc, 100 + STALE_SECS + 1).0.contains("đã cũ"));
        assert!(!render(&doc, 100).0.contains("đã cũ"));
    }

    #[test]
    fn ty_le_0_khong_dung_shadow_va_tep_mac_dinh() {
        assert!(init(|_| None).unwrap().is_none());
        assert!(
            init(|k| (k == "SHADOW_SAMPLE_RATE").then(|| "0".to_owned()))
                .unwrap()
                .is_none()
        );
        assert_eq!(file_from_env(&|_: &str| None), PathBuf::from(DEFAULT_FILE));
        let custom = file_from_env(&|k: &str| (k == "SHADOW_REPORT_FILE").then(|| " /tmp/x.json ".to_owned()));
        assert_eq!(custom, PathBuf::from("/tmp/x.json"));
    }

    #[test]
    fn ghi_tep_nguyen_tu() {
        let dir = std::env::temp_dir().join(format!("trinity-shadow-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("r.json");
        write_atomic(&path, &document(&sample(), 1, 2)).unwrap();
        let back: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back["generated_unix"], 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
