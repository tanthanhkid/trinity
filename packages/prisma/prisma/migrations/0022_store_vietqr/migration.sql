-- G05: trang bán hàng chuyển khoản bằng QR VietQR tĩnh tự sinh (không còn cần kết nối SePay).
-- Cửa hàng đang bật chuyển khoản: chép ngân hàng + số tài khoản + tên chủ TK từ cấu hình SePay cũ (connector_accounts.settings)
-- vào `settings.online_store` (bank_bin, bank_account, bank_account_name). Tên ngân hàng ánh xạ sang BIN theo bảng dưới — CHÉP
-- ĐÚNG bảng VIETQR_BANKS ở services/crm/src/store/vietqr.ts (test vietqr.spec.ts kiểm khớp). Không đọc được (không có SePay,
-- tên ngân hàng lạ, số TK sai dạng) ⇒ tắt chuyển khoản (COD vẫn chạy) và ghi `bank_notice` để nhắc chủ cửa hàng nhập lại.
-- Cấu hình hỏng (không phải JSON) thì bỏ qua — ứng dụng vốn đọc như mặc định. Chạy lại nhiều lần không sao (đã có
-- bank_bin hoặc đã tắt chuyển khoản thì không đụng). Đơn chuyển khoản cũ đang chờ giữ nguyên, nhân viên xác nhận tay.
DO $$
DECLARE
  cfg jsonb;
  sepay jsonb;
  bank_key text;
  bin text;
  acc text;
BEGIN
  BEGIN
    SELECT value::jsonb INTO cfg FROM settings WHERE key = 'online_store';
  EXCEPTION WHEN others THEN
    RETURN;
  END;
  IF cfg IS NULL OR jsonb_typeof(cfg) <> 'object' OR COALESCE(cfg->>'bank_transfer', 'false') <> 'true' OR cfg ? 'bank_bin' THEN
    RETURN;
  END IF;

  SELECT settings INTO sepay FROM connector_accounts WHERE provider = 'sepay' AND status <> 'disconnected';
  bank_key := lower(regexp_replace(COALESCE(sepay->>'bank', ''), '[^A-Za-z0-9]', '', 'g'));
  acc := regexp_replace(COALESCE(sepay->>'account_number', ''), '\s', '', 'g');
  SELECT m.bin INTO bin FROM (VALUES
    ('vietcombank', '970436'),
    ('vcb', '970436'),
    ('vietinbank', '970415'),
    ('icb', '970415'),
    ('ctg', '970415'),
    ('bidv', '970418'),
    ('agribank', '970405'),
    ('vba', '970405'),
    ('mbbank', '970422'),
    ('mb', '970422'),
    ('techcombank', '970407'),
    ('tcb', '970407'),
    ('acb', '970416'),
    ('vpbank', '970432'),
    ('vpb', '970432'),
    ('tpbank', '970423'),
    ('tpb', '970423'),
    ('sacombank', '970403'),
    ('stb', '970403'),
    ('hdbank', '970437'),
    ('hdb', '970437'),
    ('vib', '970441'),
    ('shb', '970443'),
    ('eximbank', '970431'),
    ('eib', '970431'),
    ('msb', '970426'),
    ('maritimebank', '970426'),
    ('scb', '970429'),
    ('seabank', '970440'),
    ('seab', '970440'),
    ('ocb', '970448'),
    ('lpbank', '970449'),
    ('lienvietpostbank', '970449'),
    ('lpb', '970449'),
    ('namabank', '970428'),
    ('nab', '970428'),
    ('pvcombank', '970412'),
    ('pvcb', '970412'),
    ('bacabank', '970409'),
    ('bab', '970409'),
    ('abbank', '970425'),
    ('abb', '970425'),
    ('vietabank', '970427'),
    ('vab', '970427'),
    ('ncb', '970419'),
    ('kienlongbank', '970452'),
    ('klb', '970452'),
    ('bvbank', '970454'),
    ('vietcapitalbank', '970454'),
    ('vccb', '970454'),
    ('vietbank', '970433'),
    ('baovietbank', '970438'),
    ('bvb', '970438'),
    ('saigonbank', '970400'),
    ('sgicb', '970400'),
    ('pgbank', '970430'),
    ('pgb', '970430'),
    ('gpbank', '970408'),
    ('gpb', '970408'),
    ('oceanbank', '970414'),
    ('mbv', '970414'),
    ('vikkibank', '970406'),
    ('dongabank', '970406'),
    ('dab', '970406'),
    ('cake', '546034'),
    ('ubank', '546035'),
    ('timo', '963388'),
    ('woori', '970457'),
    ('wvn', '970457'),
    ('shinhanbank', '970424'),
    ('shinhan', '970424'),
    ('shbvn', '970424'),
    ('uob', '970458'),
    ('publicbank', '970439'),
    ('pbvn', '970439'),
    ('hsbc', '458761'),
    ('indovinabank', '970434'),
    ('ivb', '970434'),
    ('vrb', '970421'),
    ('standardchartered', '970410'),
    ('scvn', '970410')
  ) AS m(alias, bin) WHERE m.alias = bank_key;

  IF bin IS NOT NULL AND acc ~ '^[0-9A-Za-z]{4,19}$' THEN
    UPDATE settings SET value = (cfg || jsonb_build_object(
      'bank_bin', bin,
      'bank_account', acc,
      'bank_account_name', NULLIF(left(btrim(COALESCE(sepay->>'account_name', '')), 80), '')
    ))::text WHERE key = 'online_store';
  ELSE
    UPDATE settings SET value = (cfg || jsonb_build_object(
      'bank_transfer', false,
      'bank_notice', 'Chuyển khoản đã tạm tắt: hãy nhập ngân hàng và số tài khoản nhận tiền rồi bật lại.'
    ))::text WHERE key = 'online_store';
  END IF;
END $$;
