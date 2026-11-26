-- G04: đăng bài chỉ còn Fanpage Facebook. YouTube, TikTok, Google Business Profile và Instagram đã gỡ khỏi mã.
-- Dữ liệu cũ của bốn mạng này thành LƯU TRỮ: không xoá dòng nào, không đụng token đã lưu, không gọi nhà cung cấp.
-- Bài đã đăng giữ nguyên (lịch sử, số liệu lần lấy cuối). Chạy lại nhiều lần vẫn cho cùng kết quả.

-- 1. Đích chưa đăng trên bốn mạng: job đăng bài không còn provider cho chúng.
--    Đang chờ (`queued`) ⇒ huỷ kèm lý do. Đang đăng dở (`publishing`, chỉ còn khi tiến trình chết giữa chừng) ⇒ lỗi,
--    vì không biết bài đã lên chưa; người dùng xem trực tiếp trên kênh.
UPDATE "social_post_targets"
SET "status" = 'cancelled',
    "claimed_at" = NULL,
    "last_error" = 'Trinity đã ngừng hỗ trợ mạng này (chỉ còn đăng bài lên Fanpage Facebook) — bài không được đăng.',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "network" IN ('youtube', 'tiktok', 'google_business', 'instagram')
  AND "status" = 'queued';

UPDATE "social_post_targets"
SET "status" = 'failed',
    "claimed_at" = NULL,
    "last_error" = 'Đang đăng dở khi Trinity ngừng hỗ trợ mạng này — kiểm tra trực tiếp trên kênh xem bài đã lên chưa.',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "network" IN ('youtube', 'tiktok', 'google_business', 'instagram')
  AND "status" = 'publishing';

-- 2. Trạng thái tổng của các bài có đích trên bốn mạng: tính lại đúng như `aggregateStatus` (social-posts.service.ts).
WITH agg AS (
  SELECT p."id",
         count(*) FILTER (WHERE t."status" <> 'cancelled') AS live,
         count(*) FILTER (WHERE t."status" = 'published') AS n_published,
         count(*) FILTER (WHERE t."status" = 'failed') AS n_failed,
         bool_or(t."status" = 'publishing') AS any_publishing,
         bool_or(t."status" = 'queued') AS any_queued,
         bool_or(t."status" IN ('published', 'failed')) AS any_done,
         (p."scheduled_at" IS NOT NULL AND p."scheduled_at" > CURRENT_TIMESTAMP) AS scheduled
  FROM "social_posts" p
  JOIN "social_post_targets" t ON t."post_id" = p."id"
  WHERE p."id" IN (
    SELECT "post_id" FROM "social_post_targets" WHERE "network" IN ('youtube', 'tiktok', 'google_business', 'instagram')
  )
  GROUP BY p."id", p."scheduled_at"
),
next AS (
  SELECT "id",
         CASE
           WHEN live = 0 THEN 'cancelled'
           WHEN any_publishing THEN 'publishing'
           WHEN any_queued THEN CASE WHEN any_done THEN 'publishing' WHEN scheduled THEN 'scheduled' ELSE 'publishing' END
           WHEN n_published = live THEN 'published'
           WHEN n_failed = live THEN 'failed'
           ELSE 'partial'
         END AS status
  FROM agg
)
UPDATE "social_posts" p
SET "status" = next.status,
    "updated_at" = CURRENT_TIMESTAMP
FROM next
WHERE p."id" = next."id"
  AND p."status" IS DISTINCT FROM next.status;

-- 3. Bài lặp: bỏ các kênh thuộc bốn mạng khỏi mẫu; bài lặp không còn kênh nào thì tắt kèm lý do (mẫu giữ nguyên để xem lại).
WITH removed AS (
  SELECT "id" FROM "social_accounts" WHERE "network" IN ('youtube', 'tiktok', 'google_business', 'instagram')
),
r AS (
  SELECT sr."id",
         COALESCE((
           SELECT jsonb_agg(e.t ORDER BY e.ord)
           FROM jsonb_array_elements(sr."template" -> 'targets') WITH ORDINALITY AS e(t, ord)
           WHERE CASE WHEN (e.t ->> 'account_id') ~ '^[0-9]{1,9}$' THEN (e.t ->> 'account_id')::int END IN (SELECT "id" FROM removed) IS NOT TRUE
         ), '[]'::jsonb) AS kept
  FROM "social_recurrences" sr
  WHERE jsonb_typeof(sr."template" -> 'targets') = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(sr."template" -> 'targets') AS x(t)
      WHERE CASE WHEN (x.t ->> 'account_id') ~ '^[0-9]{1,9}$' THEN (x.t ->> 'account_id')::int END IN (SELECT "id" FROM removed)
    )
)
UPDATE "social_recurrences" sr
SET "template" = CASE WHEN jsonb_array_length(r.kept) = 0 THEN sr."template" ELSE jsonb_set(sr."template", '{targets}', r.kept) END,
    "active" = CASE WHEN jsonb_array_length(r.kept) = 0 THEN false ELSE sr."active" END,
    "last_error" = CASE
      WHEN jsonb_array_length(r.kept) = 0 THEN 'Tạm dừng: mọi kênh của bài lặp thuộc mạng Trinity đã ngừng hỗ trợ (YouTube, TikTok, Google Business Profile, Instagram). Chọn Fanpage Facebook rồi bật lại.'
      ELSE sr."last_error"
    END,
    "updated_at" = CURRENT_TIMESTAMP
FROM r
WHERE sr."id" = r."id";

-- 4. Bài nháp chưa đăng: bỏ các kênh thuộc bốn mạng (đăng nháp với kênh đó chỉ còn báo lỗi).
WITH removed AS (
  SELECT "id" FROM "social_accounts" WHERE "network" IN ('youtube', 'tiktok', 'google_business', 'instagram')
)
UPDATE "social_drafts" d
SET "targets" = COALESCE((
      SELECT jsonb_agg(e.t ORDER BY e.ord)
      FROM jsonb_array_elements(d."targets") WITH ORDINALITY AS e(t, ord)
      WHERE CASE WHEN (e.t ->> 'account_id') ~ '^[0-9]{1,9}$' THEN (e.t ->> 'account_id')::int END IN (SELECT "id" FROM removed) IS NOT TRUE
    ), '[]'::jsonb),
    "updated_at" = CURRENT_TIMESTAMP
WHERE d."post_id" IS NULL
  AND jsonb_typeof(d."targets") = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(d."targets") AS x(t)
    WHERE CASE WHEN (x.t ->> 'account_id') ~ '^[0-9]{1,9}$' THEN (x.t ->> 'account_id')::int END IN (SELECT "id" FROM removed)
  );

-- 5. Kênh của bốn mạng: `disabled` kèm lý do. Token đã lưu giữ nguyên (đã mã hoá, không còn mã nào đọc); web và API
--    không còn liệt kê, bật lại hay liên kết các kênh này.
UPDATE "social_accounts"
SET "status" = 'disabled',
    "last_error" = 'Trinity đã ngừng hỗ trợ ' || CASE "network"
        WHEN 'youtube' THEN 'YouTube'
        WHEN 'tiktok' THEN 'TikTok'
        WHEN 'google_business' THEN 'Google Business Profile'
        ELSE 'Instagram'
      END || ': chỉ còn đăng bài lên Fanpage Facebook. Bài cũ vẫn xem được trong lịch sử.',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "network" IN ('youtube', 'tiktok', 'google_business', 'instagram')
  AND ("status" <> 'disabled' OR "last_error" IS NULL OR "last_error" NOT LIKE 'Trinity đã ngừng hỗ trợ %');
