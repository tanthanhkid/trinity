# So trạng thái DB sau kịch bản ghi (C16)

Mỗi kịch bản ghi (`cases/default/09-db-state.test.ts`) chạy một chuỗi lời gọi HTTP, rồi `dump()` (`lib/dbdump.ts`) lấy trạng thái các bảng bị đụng tới và `dbGolden(tên, dump)` ghi/so `<out>/<hồ sơ>/db/<tên>.json`, cùng cơ chế record/compare với `golden()`.

## Quy tắc dump

- Chỉ dòng **mới** của kịch bản: `mark()` ghi `max(id)` từng bảng trước kịch bản, `dump()` lấy `id > mốc`.
- Thứ tự `ORDER BY id` (id tăng theo thứ tự ghi nên hai lượt cùng kịch bản cho cùng thứ tự).
- Giá trị đi qua bộ chuẩn hoá C06a (`lib/normalize.ts`): id → `<id:khoá:n>`, người dùng → `<user:n>`, thời điểm → `<now>`/`<time:-3d>`, ngày → `<vn-day:n>`, email test → `<email:n>`, token → `<token>`. Cột `int8` (bigserial) được đổi sang số trước để cũng được chuẩn hoá; `numeric` (tiền) giữ chuỗi; `resource_id` dạng số chuỗi được đổi sang số.
- Cột trong danh sách cho phép thành `<allowed>` khi khác `null` (vẫn so được "có giá trị hay không").

## Danh sách cho phép (cột được phép khác nhau)

| Cột | Bảng | Lý do |
|---|---|---|
| `updated_at` | mọi bảng | Mốc cập nhật phụ thuộc thời điểm chạy và thứ tự ghi trong cùng mili giây; `created_at` vẫn so (về `<now>`) |
| `password_hash` | mọi bảng | Băm bcrypt có muối ngẫu nhiên |
| `code` | mọi bảng | Mã tự sinh (KH-, DL-…) là số thứ tự toàn DB: đổi khi thêm file ca khác trước đó; việc mã được sinh hay không vẫn so |
| thêm riêng từng bảng | `TableSpec.allow` | Mỗi cột thêm phải ghi lý do vào bảng này |

Mọi thứ khác (kể cả `integration_events.payload`, `audit_logs.metadata`) phải giống từng byte. Thêm bảng mới vào dump: thêm vào `TABLES` của kịch bản; thêm kịch bản: `mark` trước, `dump` sau, `dbGolden`.

## Kiểm hai lượt giống nhau

```bash
CONTRACT_PORT=4388 CONTRACT_DB_PREFIX=trinity_contract_c16 pnpm --filter @trinity/contract-tests contract -- --profile default --mode record --out /tmp/a
CONTRACT_PORT=4388 CONTRACT_DB_PREFIX=trinity_contract_c16 pnpm --filter @trinity/contract-tests contract -- --profile default --no-build --mode record --out /tmp/b
diff -r /tmp/a /tmp/b   # phải trống
```

Phía Rust: `--target cmd --mode compare --baseline /tmp/a` so dump của binary Rust với dump Node (cùng DB mẫu, cùng kịch bản).
