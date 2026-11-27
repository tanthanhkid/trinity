# So trạng thái DB sau kịch bản ghi (C16)

Mỗi kịch bản ghi (`cases/default/09-db-state.test.ts`) chạy một chuỗi lời gọi HTTP, rồi `dump()` (`lib/dbdump.ts`) lấy trạng thái các bảng bị đụng tới và `dbGolden(tên, dump)` ghi/so `<out>/<hồ sơ>/db/<tên>.json`, cùng cơ chế record/compare với `golden()`.

## Quy tắc dump

- Dòng vào dump: dòng **mới** (`id > mốc`, `mark()` ghi `max(id)` từng bảng) cộng dòng **cũ bị sửa** trong kịch bản (`updated_at >= now()` của DB lúc `mark()`, chỉ bảng có cột `updated_at`).
- Trước khi dump, `settle()` chờ ghi bất đồng bộ (outbox, audit…) xong: số dòng, `max(id)`, `max(updated_at)` không đổi qua 3 lần đọc cách nhau 150 ms (tối đa 10 s, quá hạn là lỗi).
- Thứ tự `ORDER BY id`.
- Kiểu cột: `date` giữ chuỗi `YYYY-MM-DD` (không qua `Date`) nên ra nhãn `<vn-day:n>`; `int8` và `int8[]` thành số; `numeric` (tiền) giữ chuỗi; `timestamptz` → `<now>`/`<time:-3d>` (bộ chuẩn hoá C06a).
- Id đổi thành nhãn **theo bảng**: dòng của chính dump có nhãn theo thứ tự id (`<contacts:1>`), và nhãn đó lan sang mọi cột khoá ngoại (`contact_id`, `resource_id` + `resource`) và id lồng trong jsonb (`payload.contact.id`, `…_ids`), nên nối sai dòng thì nhãn lệch. Id trỏ ra ngoài dump (người dùng, tuỳ chọn, cột kanban…) đánh số theo lần gặp đầu: `<users:ext1>`. Bảng đích của khoá suy từ tên (`x_id` → `xs`; người dùng, tuỳ chọn có luật riêng ở `tableOf`).
- Cột trong danh sách cho phép thành `<allowed>` khi khác `null` (vẫn so được "có giá trị hay không"); `ALLOW_EVERYWHERE` áp mọi độ sâu, kể cả trong jsonb.

## Danh sách cho phép (cột được phép khác nhau)

| Cột | Bảng | Lý do |
|---|---|---|
| `updated_at` | mọi bảng | Mốc cập nhật phụ thuộc thời điểm chạy và thứ tự ghi trong cùng mili giây; `created_at` vẫn so (về `<now>`) |
| `password_hash` | mọi bảng | Băm bcrypt có muối ngẫu nhiên |
| `code` | mọi bảng | Mã tự sinh (KH-, DL-…) là số thứ tự toàn DB: đổi khi thêm file ca khác trước đó; việc mã được sinh hay không vẫn so |
| thêm riêng từng bảng | `TableSpec.allow` | Mỗi cột thêm phải ghi lý do vào bảng này |

Giới hạn: dòng cũ bị sửa mà bảng không có `updated_at`, hoặc bị xoá cứng, không vào dump (kịch bản nên đọc lại qua API hoặc dump bảng liên quan); bảng không có cột `id` chưa hỗ trợ. Mọi thứ khác (kể cả `integration_events.payload`, `audit_logs.metadata`) phải giống từng byte. Thêm bảng mới vào dump: thêm vào `TABLES` của kịch bản; thêm kịch bản: `mark` trước, `dump` sau, `dbGolden`.

## Kiểm hai lượt giống nhau

```bash
CONTRACT_PORT=4388 CONTRACT_DB_PREFIX=trinity_contract_c16 pnpm --filter @trinity/contract-tests contract -- --profile default --mode record --out /tmp/a
CONTRACT_PORT=4388 CONTRACT_DB_PREFIX=trinity_contract_c16 pnpm --filter @trinity/contract-tests contract -- --profile default --no-build --mode record --out /tmp/b
diff -r /tmp/a /tmp/b   # phải trống
```

Phía Rust: `--target cmd --mode compare --baseline /tmp/a` so dump của binary Rust với dump Node (cùng DB mẫu, cùng kịch bản).
