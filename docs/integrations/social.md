# Social posting (Đăng đa kênh)

Module `services/crm/src/social/`. Write once, publish now to several linked channels, track each channel's status and retry failures.
Posts can be scheduled up to 90 days ahead (composer, calendar and the AI assistant's tools). A scheduled post can be edited (text, time, channels) until one minute before it goes out — *Bài đã đăng › Sửa* or `PATCH /social/posts/:id` — and dragged to another day on the calendar (`POST /social/posts/:id/reschedule`, keeps the time of day). On Vercel the daily cron is not enough for exact times: a due post goes out when a user with the `social.post` permission has the app open in a foreground tab (the page calls `POST /social/tick` every minute), otherwise at the next daily job. A self-hosted server runs the job every minute.
Organisation feature `social_posting` (`@RequireOrgFeature`). Screen: `/social` (tabs Soạn bài / Nháp / Lịch / Bài đã đăng / Thống kê / Thư viện / Kênh; the composer's right column switches between *Kênh* and *Xem trước*).

| Network | Status |
|---|---|
| Facebook Page | supported, with an optional first comment (posted by the Page right after the post; needs the Page connected under Settings › Connections › Facebook Page, which holds the comment permission) |
| YouTube | supported: video upload with title, own description, tags, category, made-for-kids flag, privacy (default private), custom thumbnail and playlist |
| Instagram | supported when `INSTAGRAM_PUBLISH_ENABLED=true` and the Facebook app has Instagram permissions (waiting for Meta App Review) |
| TikTok | enabled once TikTok keys are set — provider code and tests are ready (`tiktok.provider.ts`); waiting for TikTok production approval |
| Google Business Profile | enabled when `GOOGLE_BUSINESS_ENABLED=true` — business updates (text + up to 1 photo) and Google reviews in the inbox; waiting for Google to approve API access |

## Permissions
- `social.post` — compose, publish, view posts, cancel unfinished channels, retry.
- `social.manage` (sensitive) — link/unlink channels, remove a published post from the network.

Linked channels belong to the company: everyone with `social.post` can post to every active channel.

## Prerequisites (Facebook Page)
1. A Meta app with the "Manage everything on your Page" use case and the permissions `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`.
   Page videos are published with `pages_manage_posts` (no `publish_video`).
2. `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` (shared with the Facebook inbox integration).
3. Valid OAuth redirect URI in the Meta app: `https://<CRM domain>/api/v1/social/oauth/callback/facebook`.
4. `INTEGRATIONS_PUBLIC_BASE_URL` (on Vercel it falls back to the production URL) and `INTEGRATIONS_SECRET_KEY` (tokens are stored AES-256-GCM encrypted).
5. Public policy pages for app review: `https://<CRM domain>/privacy` (data deletion section `#xoa-du-lieu`) and `/terms`; contact email from `LEGAL_CONTACT_EMAIL`.
6. In Development mode the app can post to Pages of people who have a role in the app. Other companies need App Review + Business Verification.

## Prerequisites (YouTube)
1. A Google Cloud project with **YouTube Data API v3** enabled and an OAuth client of type *Web application*.
2. Authorized redirect URI: `https://<CRM domain>/api/v1/social/oauth/callback/youtube`.
3. OAuth consent screen with the scopes `youtube.upload` and `youtube.force-ssl` (reads the channel and removes videos; `videos.delete` rejects `youtube.upload`/`youtube.readonly`). In *Testing* mode only listed test users can link, and
   Google expires refresh tokens after 7 days — the channel then shows "Cần liên kết lại". Production use needs Google's verification of these sensitive scopes.
4. `GOOGLE_SOCIAL_CLIENT_ID`, `GOOGLE_SOCIAL_CLIENT_SECRET`.
5. Each post needs exactly one video. Options per channel: title (default: first line of the text, max 100 characters, `<` `>` removed)
   and privacy `private` (default) | `unlisted` | `public`. Uploads use the resumable protocol in one request; the daily upload limit of the project is shown under Google Cloud › Quotas (a quota error is retried later).

## Prerequisites (TikTok — when it is switched on)
Switch on: inject `TiktokSocialProvider` in `SocialProviderRegistry` and add it to `SocialModule` providers.
1. A TikTok developer app with **Login Kit** and **Content Posting API** (Direct Post enabled), scopes `user.info.basic`, `video.publish`.
2. Redirect URI: `https://<CRM domain>/api/v1/social/oauth/callback/tiktok`; the app review also asks for the `/privacy` and `/terms` URLs.
3. `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`.
4. Until TikTok audits the app, every post must be `SELF_ONLY` (only the creator sees it) and the creator's account must be private.
   Before each post Trinity calls `creator_info` and rejects a privacy level the account does not allow.
5. Each post needs exactly one video, uploaded with `FILE_UPLOAD` (≤ 64 MB in one chunk, larger in 10 MB chunks). TikTok processes the video
   asynchronously: Trinity waits up to 20 s for the status; a private post has no public link, so the target keeps the `publish_id`.
6. TikTok has no API to delete a post — remove it in the TikTok app.

## Prerequisites (Google Business Profile — when it is switched on)
1. Google approves *Basic API Access* for the Google Cloud project (form "GBP API contact form"; the business profile must be verified for 60+ days). Before approval every call returns quota 0.
2. In that project enable **My Business Account Management API**, **My Business Business Information API** and **Google My Business API** (v4: local posts, reviews).
3. Same OAuth client as YouTube (`GOOGLE_SOCIAL_CLIENT_ID` / `GOOGLE_SOCIAL_CLIENT_SECRET`); add the scope `https://www.googleapis.com/auth/business.manage` to the consent screen and the redirect URI `https://<CRM domain>/api/v1/social/oauth/callback/google_business`.
4. `GOOGLE_BUSINESS_ENABLED=true`. Each **location** the Google account manages becomes one channel.
5. Posting: a `STANDARD` update, text ≤ 1,500 characters, at most one JPG/PNG photo (Google fetches it from a signed public link); no video. Deleting a post from Trinity deletes it on Google.
6. Reviews: **Inbox › Đánh giá Google** reads the reviews of each location straight from Google (no copy is stored), with an "awaiting reply" filter; replies are public and sending again edits the reply. Permission `social.post`.

`GET /api/v1/social/networks` returns, per network, whether the server is configured and the exact redirect URI to register.

## Media
- Images JPG/PNG/WebP/GIF ≤ 10 MB, video MP4/MOV/WebM ≤ 200 MB, up to 10 files per post.
- Facebook: text only, 1 photo, up to 10 photos (album), or exactly 1 video (no mixing video with photos).
- YouTube (and TikTok later): exactly 1 video.
- Vercel: the browser uploads straight to Blob (`POST /social/media/upload-token`, then `POST /social/media/register`); elsewhere `POST /social/media` (multipart `file`).
- Media library (tab "Thư viện"): every uploaded file is recorded in `social_media_assets` and shared inside the company, so it can be reused in later posts
  ("Chọn từ thư viện" in the composer). `GET /social/media` lists (filter `type`, `q`, cursor), `GET /social/media/:id/file` streams a file,
  `POST /social/media/:id/hide` hides it from the library (the file stays, posts that use it are unchanged). Migration `0004_social_media_library`.

## Publishing
- "Đăng ngay" (and `create_social_post`) publishes in the background right after the request.
- Job `social.publish` claims due targets with `FOR UPDATE SKIP LOCKED`. On a VPS, temporary errors and rate limits retry after 1, 5, 15, 60 minutes, then fail.
  On Vercel there is no frequent background run, so they fail at once and the user presses Thử lại (or calls `retry_social_post_target`).
  Access tokens that expire within 5 minutes (YouTube: 1 hour) are refreshed first and saved. A token error marks the channel `reauth` (relink it under Kênh). Other errors fail at once; the user fixes the cause and presses Thử lại.
- A target stuck in "publishing" past its 15-minute lease is marked failed, never re-posted automatically, to avoid duplicate posts.
- VPS: the job runs every minute in-process. Vercel: posting runs right after the request; the daily Vercel Cron tick only sweeps leftovers.

## Drafts
A post can be saved unfinished (no channel, empty text, no time) and published later. Web: *Soạn bài › Lưu nháp* saves the composer state; the *Nháp* tab lists drafts (Mở / Xoá). Opening a draft restores the composer exactly; a draft saved by the AI is rebuilt from its channels, captions and options. Posting a loaded draft the normal way deletes it. Like posts, drafts are shared by everyone with `social.post`. Migration `0012_social_drafts`.
API (`social.post`): `GET /social/drafts`, `GET /social/drafts/:id`, `POST /social/drafts`, `PATCH /social/drafts/:id` (only the fields sent change; 409 once published), `DELETE /social/drafts/:id`, `POST /social/drafts/:id/publish` (optional `scheduled_at` overrides the draft's time; `null` posts now).
Drafts get only a light check on save (shape, existing channels, library media); the full post validation — including the 90-day / one-minute schedule rule — runs when publishing, through the same code as `POST /social/posts`. If it fails, the draft is left untouched; if it succeeds, the draft gets `post_id` and disappears from the list (the row is kept).

## Posting queue (weekly time slots)
The company defines weekly time slots (e.g. Mon–Fri 09:00 and 19:30, Sat 10:00), all in Vietnam time (Asia/Ho_Chi_Minh, UTC+7, no DST). *Vào hàng đợi* schedules a post at the next free slot: strictly after now + 2 minutes, within the 90-day schedule limit, skipping a slot that already holds a scheduled post in the same minute. Weekday is 0 = Sunday … 6 = Saturday, `minute` is minutes from 00:00 Vietnam time. Table `social_queue_slots` (migration `0013_social_queue_slots`), unique on (weekday, minute), at most 100 slots.
Web: *Lịch › Khung giờ hàng đợi* edits the slots (add / remove a time per weekday, saved as one list). In the composer the schedule choice is *Đăng ngay* / *Hẹn giờ* / *Vào hàng đợi*; the queue option shows the nearest free slot and is disabled while no slots exist. A draft saved with the queue option stores no time; publishing it sends `use_queue`.
API (`social.post`): `GET /social/queue/slots`, `PUT /social/queue/slots` (body `{ slots: [{ weekday, minute }] }`, replaces the whole list in one transaction; duplicates merged), `GET /social/queue/next?count=5` (ISO 8601 list, max 20). `POST /social/posts` and `POST /social/drafts/:id/publish` accept `use_queue: true` (when `scheduled_at` is absent): the service picks the free slot inside create; with no slots it answers 400 "Chưa đặt khung giờ hàng đợi (Đăng đa kênh › Lịch › Khung giờ)".

## Hashtag sets and signatures
Reusable text snippets for posts, table `social_snippets` (migration `0014_social_snippets`): `kind` is `hashtags` or `signature`, `name` 1–80 chars, `content` 1–2000 chars, `is_default`, `position`. Hashtag content is normalised on save: split on whitespace/commas, `#` added when missing, case-insensitive duplicates dropped, joined with single spaces; a tag longer than 100 characters or containing another `#` is rejected. At most one signature is the default (setting it clears the flag on the others in the same transaction); `is_default` is only allowed on signatures. At most 100 snippets; `kind` cannot change after creation.
Web: in the composer, the *Chèn* menu appends a snippet to the end of the common text (newline + content, skipped when the exact text is already at the end); a new empty post (not opened from a draft) is pre-filled with `\n\n` + the default signature; *Quản lý mẫu* opens a dialog to add, edit, delete and mark the default signature.
API (`social.post`): `GET /social/snippets?kind=`, `POST /social/snippets` (`{ kind, name, content, is_default? }`), `PATCH /social/snippets/:id` (only the fields sent), `DELETE /social/snippets/:id`.
MCP: `list_social_snippets` (read; hashtag sets and signatures with `id`, `name`, `content`, `is_default`) and `save_social_snippet` (scope `crm.write`; creates when `snippet_id` is omitted, otherwise updates only the fields sent; publishes nothing, so no confirmation). There is no delete tool.

## UTM tagging of links
A post can carry `utm: { campaign, content? }` (`POST /social/posts`, `PUT /social/posts/:id`, drafts; `null` removes it). `campaign` is 1–100 chars (trimmed, spaces become `-`, no `& # = ? % /`), `content` up to 100. At publish time every `http(s)` link in the text a channel sends gets `utm_source` = the network (`facebook`, `instagram`, `youtube`, `tiktok`, `google_business`), `utm_medium=social`, `utm_campaign`, and `utm_content` when set — in the caption / common text, the YouTube description option and the Facebook first comment. Links that already contain any `utm_` parameter, non-http links, e-mails and bare domains are left untouched; a `#fragment` stays last; applying twice changes nothing. The setting is stored per channel in `options.utm` (no schema change), so a draft keeps it when published and an edit keeps it; the stored caption stays clean and only the text handed to the network is tagged. Per-network character limits are checked on the text after tagging (links get longer). Web: composer checkbox *Gắn UTM vào liên kết* with a campaign field (default: slug of the first words, or `bai-<date>`), optional `utm_content` under *Nâng cao*, and a preview of the first tagged link.

## Per-channel preview
`POST /social/posts/preview` (`social.post`; same body as `POST /social/posts`) answers `{ data: { scheduled_at, from_queue, warnings, targets[] } }` and saves nothing. It runs the same text pipeline as publishing: the caption (or common text) after UTM tagging, so what you see is what the network receives. Per channel: `account_id`, `account_name`, `network`, `text`, `title` and `description` (YouTube; title is pinned from the untagged text), `first_comment` (Facebook, after UTM), `length` / `limit` (`CAPTION_LIMITS`), `truncated_at`, `media` (`[{key, type}]`) and `warnings`. Unlike create, limit, media, permission and re-link problems do not throw: they come back as `warnings` (channel-level) or top-level `warnings` (missing media, bad schedule, no queue slot) so the composer can show them while the user edits. With `use_queue: true` the next free slot is read (not reserved), so a later create may pick a different one.

`truncated_at` is where the network hides text behind "See more" (character offset into `text`, or into `description` for YouTube; `null` = shown in full). The numbers are approximations kept in `SEE_MORE_AT` (`social.config.ts`): Facebook 480 characters or 5 lines, Instagram 125, TikTok 150, YouTube description 160, Google Business 1500; real clients vary by device and layout. Web: the composer's *Xem trước* tab renders one card per chosen channel (debounced ~400 ms, not called with no channel chosen).

## Bulk import from CSV (Nhập nhiều bài từ CSV)
Create many drafts or scheduled posts from one CSV (UTF-8, optional BOM; fields follow RFC 4180: quoted fields, `""` for a quote, CRLF or LF; the separator is a comma or a semicolon, detected from the header row). At most 200 data rows and 1 MB of text. The first row is the header; names are matched ignoring case and diacritics, Vietnamese or English:

| Column | Aliases | Notes |
|---|---|---|
| `content` | `noi_dung` | Required unless `media` is given. |
| `channels` | `kenh` | Account ids or exact account names separated by `;` or `,`. Required for scheduled posts, optional for drafts. A name shared by several accounts is an error: use the id. |
| `scheduled_at` | `gio_dang` | Vietnam time `YYYY-MM-DD HH:mm` or `DD/MM/YYYY HH:mm`. The value `queue` or `hang doi` uses the posting queue. Empty: no time for drafts; an error for scheduled posts. |
| `media` | `tep` | Library keys or original file names, separated by `;`. Matched by key first, then by exact name (several files with the same name: the newest is used, with a warning). |
| `first_comment` | `binh_luan_dau` | Applied to the Facebook channels of the row. |
| `youtube_title` | `tieu_de_youtube` | Applied to the YouTube channels of the row. |
| `utm_campaign` | `utm` | Same as the post-level UTM setting (see above). |

Modes: `drafts` creates drafts (nothing is published, no confirmation); `schedule` creates scheduled posts and **never publishes immediately**: a row without a time or `queue` is rejected ("Cần giờ đăng hoặc 'hàng đợi'"), a time must be more than 1 minute ahead and within 90 days. Queue rows get distinct slots: the free slots are requested once for all queue rows and assigned in row order (at most 50 queue rows per import; extra rows are reported as errors).

API (`social.post`):
- `POST /social/posts/import/plan` with `{ csv, mode }` validates every row with the same checks as create (drafts: the draft checks) and answers `{ data: { mode, plan_hash, total, ok_count, error_count, rows[], unknown_columns? } }`. Each row: `{ row, ok, errors[], warnings[], preview: { channels: [{account_id, name, network}], scheduled_at, use_queue, content_excerpt } }`, where `row` is the line number in the file (the header is line 1). Nothing is saved and no queue slot is reserved.
- `POST /social/posts/import` with `{ csv, mode, plan_hash }` plans again and answers **409** when the hash differs from the one the user reviewed (the hash covers the normalised rows with resolved channel ids and media keys, the row status and the mode; queue slots are not part of it). Only rows that are `ok` are created, each independently, in row order, and a failing row does not roll back the others: `{ mode, created: [{ row, id }], skipped: [{ row, errors[] }] }` (`id` is a draft id or a post id).

Web: *Lịch › Nhập CSV* — choose *Tạo nháp* / *Hẹn đăng*, pick a file or paste the text, *Kiểm tra* shows a table (errors in red, warnings in amber), *Tạo N bài* imports the valid rows with the reviewed `plan_hash`; *Tải file mẫu* downloads a template with Vietnamese headers and two example rows (using the user's channel names). Changing the text or the mode after the check requires checking again.

MCP: `import_social_posts` takes structured `rows` (at most 50: `content`, `account_ids`, `scheduled_at` or `use_queue`, `media_keys`, `first_comment`, `youtube_title`, `utm_campaign`) and `mode`. `drafts` writes directly (scope `crm.write`, nothing published). `schedule` is public: without `confirmed_by_user` it only returns the per-row preview (channels, time, errors); with the user's approval it creates the valid rows. The approval stores the normalised rows and the plan hash and re-plans at execution, refusing when anything changed since the preview.

## MCP tools
Read: `list_social_accounts`, `list_social_posts`, `get_social_post`, `get_social_post_stats`, `list_social_media`, `list_youtube_playlists`, `preview_social_post` (same inputs as `create_social_post` minus `confirmed_by_user`; returns each channel's text, title, first comment, length/limit, `truncated_at` and warnings; posts nothing), `list_queue_slots` (weekly slots as `{weekday, weekday_text, time}` plus `next_free`, the next 5 free times in Vietnam time), `list_social_drafts` (drafts with channels, per-channel captions/options, Vietnam-time schedule and `edit_url`), `refresh_social_post_metrics` (scope `crm.write`: stores the new figures; `refresh_failed` lists channels that kept their previous figures) (fetches the latest numbers of one post now).
Write (scope `crm.write`, logged in AI activity): `create_social_post` (optional `use_queue` puts the post in the nearest free queue slot instead of `scheduled_at`; it is resolved at preview, so the approved post goes out at the time the user saw; both together, or no slots, is an error; per-channel `captions[]` may also carry `youtube_title`, `youtube_privacy`, `youtube_description`, `youtube_tags`, `youtube_category`, `youtube_made_for_kids`, `youtube_thumbnail_media_key`, `youtube_playlist_id`, `facebook_first_comment`; optional `utm_campaign` / `utm_content` tag the links (see UTM above) and the preview shows a `UTM: campaign=…` line; requires `confirmed_by_user` — the user's own approval after seeing text and channels), `update_scheduled_post` (text, time, channels and per-channel options of a post that has not started publishing; omitted fields are kept; `utm_campaign` / `utm_content` change the UTM tagging, `utm_campaign: ""` removes it; requires `confirmed_by_user`), `reschedule_social_post` (time only),
`set_queue_slots` (scope `crm.write`; replaces the whole slot list from `slots: [{weekday 0-6, time "HH:mm"}]`, so send the existing slots plus the new ones; nothing is published, so no confirmation), `save_social_draft` (creates a draft, or updates it when `draft_id` is given; only the fields sent change; optional `utm_campaign` / `utm_content` are stored in the draft's channel options; publishes nothing, so no confirmation), `publish_social_draft` (posts a draft now or at its time; optional `use_queue` takes the nearest free queue slot instead of `scheduled_at`, resolved to a concrete time at preview and stored that way in the approval; optional `scheduled_at` override; requires `confirmed_by_user`; the approval keeps only `draft_id` and the override, so the latest draft is posted), `retry_social_post_target`, `upload_social_media` (a public image/video URL — no redirects, private addresses blocked, video ≤ 100 MB — or `data_base64` ≤ 3 MB;
the file goes into the library and the tool returns its `media_key`). Removing a published post or hiding a library file is done on the `/social` screen only (MCP has no delete tools, drafts included).
`media_keys` take keys from the library.

## Data model
`social_accounts` (one Page/channel; encrypted tokens; `status` active | reauth | disabled), `social_posts` (shared content, media, `scheduled_at`, aggregate status),
`social_post_targets` (post × channel: own caption/options, status, attempts, `next_attempt_at`, link, last error). Migration `0002_social_posting`.
`social_drafts` (unfinished posts; `post_id` set once published, `use_queue`; migrations `0012`/`0013`), `social_queue_slots` (weekday + minute, Vietnam time; `0013`), `social_snippets` (hashtag sets and signatures; `0014`). UTM settings live in each target's `options.utm` (no column).
