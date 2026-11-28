# Đăng nhập không mật khẩu: mã qua email và Google

Từ #675, Trinity đăng nhập giống claude.ai:

- Màn `/login` chỉ có ô email, nút **Tiếp tục với email** và nút **Tiếp tục với Google**. Mật khẩu còn là đường phụ
  («Đăng nhập bằng mật khẩu») cho tài khoản cũ.
- Nhập email ⇒ máy chủ gửi một thư có **mã 6 số** và **link đăng nhập một lần** (dùng cái nào cũng được: link cho máy đang
  mở thư, mã cho trường hợp đọc thư trên điện thoại khác máy). Mã/link hết hạn sau 10 phút và chỉ dùng được một lần.
- Google: OpenID Connect, chỉ xin `openid email profile`. Email Google đã xác minh trùng tài khoản sẵn có ⇒ vào đúng tài
  khoản đó (và gắn Google vào tài khoản). Email chưa có tài khoản ⇒ không tự tạo: theo luật cũ (đăng ký công ty mới nếu bản
  cài đặt mở đăng ký, hoặc nhận lời mời).
- Nhận lời mời (`/invite/<token>`): nhập họ tên ⇒ nhận mã ở email được mời ⇒ vào công ty, không bắt đặt mật khẩu.
- **Cài đặt › Tài khoản**: liên kết / gỡ Google, đặt / đổi / bỏ mật khẩu (không cho bỏ đường đăng nhập cuối cùng).

Thiếu cấu hình nào thì màn đăng nhập ẩn luồng đó (`GET /api/v1/auth/methods` báo `email_login_enabled`,
`google_enabled`, `password_login_enabled`). Không cấu hình gì ⇒ vẫn đăng nhập bằng mật khẩu như cũ.

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `SMTP_HOST`, `MAIL_FROM` | Có cả hai ⇒ bật đăng nhập bằng email. `MAIL_FROM` dạng `Trinity <no-reply@ten-mien.vn>` |
| `SMTP_PORT` | Mặc định 587 (465 khi `SMTP_SECURITY=tls`) |
| `SMTP_USER`, `SMTP_PASS` | Tài khoản SMTP |
| `SMTP_SECURITY` | `starttls` (mặc định, bắt buộc nâng cấp TLS), `tls` (SMTPS 465), `none` (chỉ cho SMTP giả trên máy như mailpit) |
| `MAIL_REPLY_TO` | Địa chỉ nhận khi người dùng bấm Trả lời (tuỳ chọn) |
| `SES_CONFIGURATION_SET` | Amazon SES: thêm header `X-SES-CONFIGURATION-SET` để SES ghi sự kiện gửi/nảy/khiếu nại (tuỳ chọn) |
| `APP_PUBLIC_URL` | Địa chỉ web công khai để dựng link trong thư (không có thì dùng `INTEGRATIONS_PUBLIC_BASE_URL`; không có cả hai thì thư chỉ có mã) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Đủ cả ba ⇒ hiện nút Google. Thiếu một ⇒ máy chủ báo lỗi lúc khởi động |
| `PASSWORD_LOGIN_ENABLED` | `false` ⇒ tắt hẳn đăng nhập bằng mật khẩu (chỉ còn email/Google) |

Cấu hình SMTP/Google sai (cổng, địa chỉ, redirect URI không phải https…) thì `trinity serve` từ chối khởi động và nói rõ
biến nào sai, thay vì tắt lặng lẽ.

## Tạo OAuth client Google

1. Vào Google Cloud Console › **APIs & Services › OAuth consent screen**: chọn *External*, điền tên ứng dụng (Trinity hoặc
   tên công ty), email hỗ trợ, tên miền; phạm vi chỉ cần `openid`, `email`, `profile` (không phải nộp xét duyệt). Bấm
   *Publish app* để người ngoài danh sách test đăng nhập được.
2. **Credentials › Create credentials › OAuth client ID**, loại *Web application*.
   - *Authorized JavaScript origins*: `https://<địa chỉ web>`.
   - *Authorized redirect URIs*: `https://<địa chỉ web>/api/v1/auth/google/callback` (chạy trên máy:
     `http://localhost:3000/api/v1/auth/google/callback`).
3. Chép *Client ID* và *Client secret* vào `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; `GOOGLE_REDIRECT_URI` đúng bằng
   redirect URI đã khai ở bước 2. Khởi động lại máy chủ.

Máy chủ kiểm `id_token` bằng khoá công khai của Google (JWKS, có bộ nhớ đệm, tự tải lại khi Google xoay khoá): chữ ký RS256,
`iss`, `aud`/`azp` = client ID, `exp`, `nonce`, `email_verified = true`. Luồng có `state` (buộc vào trình duyệt bằng cookie
HttpOnly `trinity_google_state`) và PKCE S256.

## Cấu hình SMTP (Amazon SES hoặc dịch vụ khác)

Amazon SES:

1. SES › **Verified identities** › thêm *domain* gửi thư (vd `ten-mien.vn`), bật **Easy DKIM** (RSA 2048) và thêm 3 bản ghi
   CNAME SES đưa vào DNS. Tuỳ chọn: *Custom MAIL FROM domain* (vd `mail.ten-mien.vn`) để SPF căn khớp tên miền.
2. Ra khỏi *sandbox* (Account dashboard › Request production access), nếu không chỉ gửi được tới địa chỉ đã xác minh.
3. **SMTP settings** › *Create SMTP credentials* ⇒ `SMTP_USER`, `SMTP_PASS`; `SMTP_HOST` là endpoint của vùng
   (`email-smtp.<vùng>.amazonaws.com`), cổng 587.
4. Tuỳ chọn: tạo *configuration set* (theo dõi nảy/khiếu nại) và đặt tên vào `SES_CONFIGURATION_SET`.

Dịch vụ khác (Postmark, Mailgun, SendGrid, Google Workspace…): dùng thông số SMTP của dịch vụ, cổng 587 + STARTTLS.

### SPF, DKIM, DMARC — để thư không vào thư rác

- **SPF**: một bản ghi TXT trên tên miền gửi (hoặc MAIL FROM domain), vd `v=spf1 include:amazonses.com -all`
  (thêm `include:` của dịch vụ khác nếu có; chỉ một bản ghi SPF cho mỗi tên miền).
- **DKIM**: bật ở dịch vụ gửi (SES Easy DKIM: 3 CNAME), kiểm thư nhận được có `dkim=pass` với `d=<tên miền của bạn>`.
- **DMARC**: TXT tại `_dmarc.<tên miền>`, bắt đầu bằng `v=DMARC1; p=none; rua=mailto:dmarc@<tên miền>`; chạy ổn vài tuần
  thì nâng lên `p=quarantine` rồi `p=reject`.
- Kiểm: gửi một mã tới địa chỉ của [mail-tester.com](https://www.mail-tester.com) (mục tiêu ≥ 9/10) và xem header
  `Authentication-Results` có `spf=pass`, `dkim=pass`, `dmarc=pass`.

Thư Trinity gửi có bản chữ + HTML, `Message-ID`, `Date`, `Reply-To` (nếu đặt), tiêu đề rõ («Mã đăng nhập Trinity:
123456»), link đầy đủ tên miền (không rút gọn), không ảnh ngoài.

## Bảo mật

- DB chỉ lưu HMAC-SHA256 của mã/token (khoá suy từ `JWT_SECRET`, không nằm trong DB), so sánh hằng thời gian. Bảng
  `login_challenges` (từng công ty) ghi email, hạn, số lần sai, thời điểm dùng, IP, user-agent.
- Giới hạn: 5 lần nhập sai mỗi mã, 3 thư mỗi email mỗi 15 phút, 10 lần gửi mã mỗi IP mỗi giờ; mã mới làm mã cũ mất hiệu lực.
- `POST /auth/email/start` trả cùng một phản hồi dù email có tài khoản hay không; thư gửi ở tác vụ nền nên thời gian trả lời
  cũng như nhau.
- Link trong thư trỏ về trang web `/auth/email#token=…` (phần sau `#` không tới máy chủ, không vào log/Referer); trang web
  gọi `POST /auth/email/callback`. Token không bị tiêu thụ bằng GET nên trình quét link của hộp thư (Outlook Safe Links…)
  không đốt mất link.
- Sau Google, phiên trao cho web bằng vé một lần 60 giây trong fragment `/auth/complete#ticket=…`. Tham số `next` chỉ nhận
  đường dẫn nội bộ (chống open redirect).
- Nhật ký `audit_logs` (`action = 'login'`) ghi `metadata.method`: `password`, `email_code`, `email_link`, `google`.
- Tài khoản không mật khẩu lưu `password_hash = ''`; đăng nhập mật khẩu với tài khoản đó vẫn tốn một lần băm (thời gian trả
  lời không lộ tài khoản nào chưa đặt mật khẩu).

## Chạy thử trên máy

SMTP giả: `brew install mailpit && mailpit` (giao diện http://localhost:8025), rồi đặt `SMTP_HOST=127.0.0.1`,
`SMTP_PORT=1025`, `SMTP_SECURITY=none`, `MAIL_FROM=Trinity <no-reply@example.com>`, `APP_PUBLIC_URL=http://localhost:3000`.
Test tự động dùng SMTP giả trong tiến trình (`trinity_mail::fake_smtp`) và JWKS/id_token giả (wiremock), không gửi thư thật.

Không có tool MCP cho phần này: đăng nhập và quản lý cách đăng nhập là việc của người dùng, không phải của agent.
