# Kiểm kê dữ liệu kết nối sắp gỡ (R002)

`scripts/ops/kiem-ke-ket-noi.sh` — chỉ đọc, cần `psql`.

```bash
DATABASE_URL=postgresql://<vai-trò-chỉ-đọc>@host/db scripts/ops/kiem-ke-ket-noi.sh              # mọi công ty
DATABASE_URL=... scripts/ops/kiem-ke-ket-noi.sh --company 1                                      # một công ty
```

In, cho mỗi schema công ty: số dòng 10 bảng sẽ lưu trữ; `social_accounts`, `social_post_targets` theo mạng và trạng thái;
bài hẹn giờ và bài lặp còn hiệu lực theo mạng; khoá `online_store`, `org_features` trong `settings`;
`payment_intents` (pending chưa hết hạn / hết hạn / còn lại) và `store_orders` theo trạng thái; `platform.company_routes` theo `kind`.
Mạng không nằm trong `KEEP_NETWORKS` (mặc định `facebook,zalo`) được đánh dấu `GỠ`. Bảng chưa có trong schema thì bỏ qua.

Chỉ phát `SELECT`; mọi phiên đặt `default_transaction_read_only = on`. Nên nối bằng vai trò DB chỉ có quyền `SELECT`.
Điều kiện của G07b: mục `7.` không còn dòng `pending (ĐANG CHỜ, chưa hết hạn)` ở mọi công ty.
