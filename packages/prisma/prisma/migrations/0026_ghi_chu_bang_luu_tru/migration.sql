-- G09: ghi chú cho 10 bảng LƯU TRỮ (tính năng đã gỡ ở G02, G06, G07b; docs/rust/PLAN.md mục 2.3).
-- Chỉ COMMENT ON TABLE: không đổi dữ liệu, không đổi cột, không xoá bảng. Số dòng mỗi bảng giữ nguyên.
-- Chạy lại nhiều lần cho cùng kết quả.
COMMENT ON TABLE "google_connections" IS 'LƯU TRỮ: tích hợp Google đã gỡ (G02/G03). Không còn mã đọc/ghi; giữ dữ liệu cũ.';
COMMENT ON TABLE "google_sheet_syncs" IS 'LƯU TRỮ: đồng bộ Google Sheets đã gỡ. Không còn mã đọc/ghi; giữ dữ liệu cũ.';
COMMENT ON TABLE "google_sheet_sync_runs" IS 'LƯU TRỮ: nhật ký đồng bộ Google Sheets đã gỡ. Không còn mã đọc/ghi; giữ dữ liệu cũ.';
COMMENT ON TABLE "extensions" IS 'LƯU TRỮ: chương trình con (extension) đã gỡ (G02). Không còn mã đọc/ghi; giữ dữ liệu cũ.';
COMMENT ON TABLE "extension_versions" IS 'LƯU TRỮ: phiên bản chương trình con đã gỡ (G02). Không còn mã đọc/ghi; giữ dữ liệu cũ.';
COMMENT ON TABLE "extension_runs" IS 'LƯU TRỮ: nhật ký chạy chương trình con đã gỡ (G02). Không còn mã đọc/ghi; giữ dữ liệu cũ.';
COMMENT ON TABLE "connector_accounts" IS 'LƯU TRỮ: kết nối bán hàng/sàn và cổng thanh toán đã gỡ (G06/G07b), khoá đã xoá. Giữ dòng cũ.';
COMMENT ON TABLE "connector_events" IS 'LƯU TRỮ: sự kiện từ kết nối bán hàng/sàn và cổng thanh toán đã gỡ. Không còn mã đọc/ghi; giữ dữ liệu cũ.';
COMMENT ON TABLE "connector_records" IS 'LƯU TRỮ: bản ghi đồng bộ từ phần mềm bán hàng/sàn đã gỡ (G06). Không còn mã đọc/ghi; giữ dữ liệu cũ.';
COMMENT ON TABLE "payment_intents" IS 'LƯU TRỮ: yêu cầu thanh toán qua cổng đã gỡ (G07b). Không còn mã đọc/ghi; giữ dữ liệu cũ.';
