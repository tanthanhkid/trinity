# Bộ kiểm bất biến dữ liệu (X11)

Trong giai đoạn lai Node và Rust cùng ghi một DB. `trinity check-invariants` chạy **chỉ đọc** (phiên
`default_transaction_read_only = on`) trên mọi schema công ty (`public`, `c_<id>`) và báo dữ liệu sai sớm. Đỏ thì dừng
bật đợt cutover kế tiếp (PLAN mục 6.5, 6.6).

| Kiểu | Kiểm |
|---|---|
| `row_count_drop` | số dòng mỗi bảng không sụt quá `--min-drop-rows` dòng **và** `--drop-pct` % so với lần chạy sạch trước (mặc định 10 dòng và 20%) |
| `updated_at_regress` | `max(updated_at)` mỗi bảng không lùi so với lần trước; không dòng nào có `updated_at < created_at` |
| `duplicate_code` | `code` của `contacts`, `deals`, `kanban_cards`, `custom_records`, `pos_orders`, `store_orders` không trùng |
| `json_unreadable` | cột `json`/`jsonb` không bị mã hoá hai lần (chuỗi chứa đối tượng/mảng JSON, đếm trên cả bảng, cần Postgres 16; JSON `null` không tính lỗi) và đúng kiểu mà giá trị mặc định nêu (`'[]'` mảng, `'{}'` đối tượng), tức bộ đọc của bản TS dùng được ngay |
| `orphan_soft_fk` | không dòng mồ côi ở các soft-FK chính (`SOFT_FKS` trong `server/crates/trinity-ops/src/lib.rs`); cha bị soft-delete vẫn tính là có cha |

Báo cáo chỉ có tên bảng, cột, số lượng, id/mã khoá mẫu; **không có giá trị dữ liệu**.

## Chạy

```sh
DATABASE_URL=postgresql://… trinity check-invariants --state /var/lib/trinity/invariants.json
```

- Mã thoát: 0 sạch, 1 có vi phạm, 2 lỗi chạy (DB, tệp trạng thái).
- `--state`: tệp mốc lần chạy sạch trước. Không có tệp (lần đầu) thì chỉ chạy các kiểm không cần mốc. Mốc chỉ được ghi
  khi lượt chạy sạch, nên cảnh báo không tự tắt ở lượt sau. Xoá cứng có chủ đích (vd dọn dữ liệu) thì xác nhận bằng
  `--accept` để ghi mốc mới.
- `--schema c_12` giới hạn một schema; `--json` in báo cáo JSON.
- Thời gian: một lượt đếm mỗi bảng và vài truy vấn nhẹ mỗi cột JSON; mục tiêu dưới 5 phút cho mọi schema.

## Lịch

Một lượt mỗi ngày suốt giai đoạn lai; **mỗi giờ trong 72 giờ đầu của mỗi đợt** thì đổi sang lịch giờ (bỏ dòng hằng
ngày trong lúc đó, để không có hai lượt cùng ghi mốc). Bọc `flock -n` để lượt sau bỏ qua nếu lượt trước chưa xong:

```cron
# hằng ngày
0 3 * * *  flock -n /var/lock/trinity-invariants.lock trinity check-invariants --state /var/lib/trinity/invariants.json || /usr/local/bin/bao-dong
# 72 giờ đầu của đợt (thay dòng trên)
0 * * * *  flock -n /var/lock/trinity-invariants.lock trinity check-invariants --state /var/lib/trinity/invariants.json || /usr/local/bin/bao-dong
```

Tệp mốc ghi qua tệp tạm có PID rồi đổi tên, nên không bao giờ để lại tệp dở. Chạy với `--schema` chỉ thay mốc của
schema vừa kiểm; schema yêu cầu mà không tồn tại thì thoát mã 2. Bảng hoặc schema có trong mốc mà biến mất được báo như
`row_count_drop` ("mất bảng", "mất schema"). Phiên chạy đặt `statement_timeout = 0` như `trinity migrate`.

## Thử

`TEST_DATABASE_URL=… cargo test -p trinity-ops --tests -- --ignored`: dựng schema `c_9301`, cố ý làm hỏng từng kiểu
trong năm kiểu trên và kiểm bộ kiểm bắt đúng kiểu đó (và dữ liệu sạch thì xanh).
