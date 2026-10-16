<div align="center">

# Trinity

**CRM mã nguồn mở vận hành bằng AI.** Tầm nhìn: hệ điều hành AI cho doanh nghiệp.
Điều hành cả công ty chỉ bằng cách trò chuyện với trợ lý AI bạn yêu thích: ChatGPT, Claude, Gemini và nhiều hơn nữa.

Tác giả: **Trần Tấn Thành** · [X @trntnthnh](https://x.com/trntnthnh) · [YouTube](https://www.youtube.com/@ltvaicom) · [TikTok](https://www.tiktok.com/@laptrinhvoiai)

[English](README.md) · [Website](https://phanmemtrinity.com) · [Triển khai](#triển-khai) · [Lộ trình](ROADMAP.md) · [Đóng góp](CONTRIBUTING.md)

</div>

---

<p align="center"><img src="docs/demo/trinity-demo.gif" width="400" alt="ChatGPT dựng một CRM nhỏ trong Trinity: bạn mô tả, bảng và dữ liệu hiện ra, trang chủ ghi lại AI đã làm gì hôm nay"></p>

<p align="center"><sub>Quay thật: ChatGPT có plugin Trinity, chạy trên một bản mới cài bằng nút Deploy Vercel bên dưới. AI làm việc bằng quyền của bạn nên các thay đổi hiện ra ngay.</sub></p>

## Vì sao là Trinity

Phần mềm quản lý nào cũng bắt bạn học menu. Trinity làm ngược lại: **bạn nói với trợ lý AI việc cần làm, AI điều khiển hệ thống thay bạn.**

- **"Thêm anh Nam ở Gò Vấp, quan tâm sản phẩm A, thứ Sáu gọi lại."** Xong: có khách, có cơ hội, có lịch nhắc.
- **"Chiến dịch quý 3 so với quý 2 thế nào?"** Trợ lý đọc dữ liệu, trả lời kèm biểu đồ.
- **"Sáng nào cũng lấy đơn mới từ Google Sheet của tôi vào."** Trinity tự tạo một tiện ích nhỏ cho việc đó. Tiện ích chạy tách riêng, lỗi cũng không ảnh hưởng hệ thống chính.

**Mở ra gọn, lớn lên cùng doanh nghiệp.** Lần đầu kết nối, AI hỏi về công việc của bạn, nhận file Excel/Google Sheet, rồi dựng quy trình và màn hình bạn cần. Bộ cơ bản (Tổng quan, Khách hàng, Công việc, Báo cáo, Hộp thư) bật sẵn; phần còn lại là công tắc ở Cài đặt › Tính năng, menu chỉ hiện thứ đang bật. AI bật giúp đúng tính năng cho ngành của bạn được.

**Làm cho doanh nghiệp Việt trước tiên.** Zalo, VietQR, giao diện và định dạng dữ liệu tiếng Việt có sẵn. Đây là những thứ CRM nước ngoài không có.

## Cách hoạt động

Trinity có sẵn **MCP server** ([Model Context Protocol](https://modelcontextprotocol.io)) đăng nhập bằng OAuth. Trong app, màn *Bắt đầu* hỏi bạn dùng trợ lý AI nào (ChatGPT, Claude, Claude Code, Antigravity, Gemini CLI, Cursor, Codex CLI, VS Code Copilot…) rồi chép sẵn một prompt: dán vào là trợ lý tự gắn máy chủ, mở trang đăng nhập và bắt đầu dựng hệ thống. Trợ lý AI nào hỗ trợ MCP cũng kết nối được và nhận bộ công cụ thao tác bản ghi, quy trình, báo cáo, tiện ích, theo đúng quyền của người kết nối. Máy chủ Trinity không tự gọi AI và không giữ khoá AI nào: trí tuệ đến từ trợ lý của chính bạn.

## Tính năng

| Mảng | Có gì |
|---|---|
| **Điều khiển bằng AI (MCP)** | MCP server có sẵn: kết nối ChatGPT, Claude, Gemini, Cursor, OpenClaw hay bất kỳ trợ lý nào hỗ trợ MCP; đọc và ghi dữ liệu trực tiếp trong phạm vi quyền của người đã kết nối (ghi cần scope `crm.write`; mọi thao tác hiện ở mục Hoạt động AI). Có tuỳ chọn *Yêu cầu duyệt thay đổi do AI*: bật lên thì AI chỉ soạn nháp, người duyệt |
| **Tự mở rộng** | Nhờ AI làm tiện ích đồng bộ, quy trình riêng, tích hợp mới; mỗi tiện ích chạy cô lập, tự tắt khi lỗi lặp lại |
| **Tổng quan kiểu AI** | Trang đầu cho thấy trợ lý AI nào đang kết nối và đang làm việc, hôm nay AI đã làm gì, và mọi kênh đã nối (Fanpage, Zalo OA, YouTube, thanh toán, trang bán hàng) kèm trạng thái và số liệu hôm nay. Chưa nối AI thì hướng dẫn nối từng bước |
| **Bật/tắt tính năng** | Cài đặt › Tính năng: thẻ chia nhóm (cơ bản, kênh & hộp thư, bán hàng, nhân sự, nâng cao), mỗi tính năng một công tắc. Tắt thì ẩn với mọi người, dữ liệu vẫn giữ. AI cũng xem và bật/tắt được (tắt cần bạn đồng ý) |
| **Hộp thư chung** | Tin Messenger và Zalo OA ở một chỗ, có ô tìm và bộ lọc "Chưa trả lời"; trả lời đúng khung thời gian mỗi nền tảng cho phép |
| **Tự động hoá Fanpage** | Tự trả lời bình luận, ẩn bình luận có số điện thoại, nhắn riêng; link và mã QR mở thẳng cuộc chat; kịch bản Messenger; gửi tin hàng loạt trong cửa sổ 24 giờ |
| **Đăng đa kênh** | Soạn một lần, đăng ngay hoặc hẹn giờ lên Fanpage Facebook và YouTube; có lịch nội dung, thư viện ảnh/video, số liệu bài. Lưu nháp, hàng đợi theo khung giờ cố định mỗi tuần, bộ hashtag và chữ ký dùng lại, tự gắn UTM vào liên kết, xem trước bài trên từng kênh. Mọi việc cũng làm được qua trợ lý AI |
| **Thanh toán** | Yêu cầu thanh toán kèm mã VietQR, SePay tự khớp khi tiền về; link thanh toán VNPay, MoMo |
| **Kết nối bán hàng** | KiotViet, Sapo, WooCommerce, MISA, Shopee, Lazada: đồng bộ về CRM những gì API từng bên cho (khách, đơn và/hoặc hàng hoá); khách được ghép theo số điện thoại khi nền tảng cung cấp (Shopee che số người mua). Phạm vi từng connector ở [status.md](docs/integrations/status.md) |
| **Trang bán hàng** | Trang bán online `/s/<tên>` (hoặc tên miền phụ), 3 giao diện, giỏ hàng, COD hoặc chuyển khoản QR; đơn và người mua vào thẳng CRM. Mặc định tắt |
| **CRM** | Danh bạ với nguồn, giai đoạn, trạng thái do bạn tự đặt, Kanban, mã bản ghi chung và gắn thẻ `@` giữa các màn, bảng tin |
| **Bán hàng** | Sản phẩm, POS |
| **Nhân sự** | Hồ sơ, chấm công, lương |
| **Báo cáo** | Dashboard, báo cáo |
| **Phân quyền** | Vai trò và phạm vi dữ liệu |

### Đã thử tới đâu

- **Thử trọn vòng trên bản cài mới** (nút Vercel, cơ sở dữ liệu Postgres mới): đăng nhập lần đầu, nối trợ lý AI, dựng bảng bằng chat, nhập dữ liệu, các tool AI.
- **Thử với tài khoản thật**: đăng ngay và hẹn giờ lên Fanpage và YouTube, tin nhắn Messenger.
- **Mới thử với dữ liệu mẫu**: hàng đợi đăng bài, bài lặp lại, nhập CSV, dashboard và báo cáo, Tổng quan kiểu AI, bật/tắt tính năng, POS, nhân sự, chấm công, lương, trang bán hàng (cửa hàng mẫu).
- Các mảng này có test tự động; connector ở bảng dưới.

### Connector và mức đã thử

| Connector | Đã thử |
|---|---|
| Fanpage Facebook, YouTube | Với tài khoản thật |
| Zalo OA | Nhận tin đã thử thật; trả lời + đọc hồ sơ cần OA gói Tier (chưa thử) |
| VNPay | Trọn vòng trên sandbox VNPay |
| MoMo | Môi trường test của MoMo |
| WooCommerce | Trọn vòng với một cửa hàng thử |
| n8n | Workflow mẫu chạy thật với máy chủ thử |
| SePay, KiotViet, Sapo, MISA, Shopee, Lazada, Zapier, Make | Connector có sẵn, chưa thử với tài khoản thật |
| Instagram, TikTok, Google Business Profile | Connector có sẵn, chưa thử với tài khoản thật; nền tảng cần duyệt app trước |
| iPOS | Chưa làm — chờ iPOS cấp API đối tác |

Chi tiết từng connector: [docs/integrations/status.md](docs/integrations/status.md). Việc sắp làm: [ROADMAP.md](ROADMAP.md).

## Xem nhanh

<table>
<tr>
<td width="50%"><img src="docs/screenshots/connections.png" alt="Cài đặt › Kết nối: mọi kênh, cổng thanh toán và connector bán hàng trên một màn kèm trạng thái"><br><sub>Mọi kênh và connector trên một màn</sub></td>
<td width="50%"><img src="docs/screenshots/inbox.png" alt="Hộp thư chung có ô tìm và lọc chưa trả lời"><br><sub>Hộp thư chung Messenger + Zalo OA</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/posting-calendar.png" alt="Lịch đăng đa kênh với bài đã hẹn giờ và đã đăng"><br><sub>Lịch nội dung đăng đa kênh</sub></td>
<td><img src="docs/screenshots/payments.png" alt="Thanh toán: SePay, VNPay, MoMo và yêu cầu thanh toán"><br><sub>Thanh toán: QR SePay, VNPay, MoMo</sub></td>
</tr>
</table>

<p align="center"><img src="docs/demo/online-store.gif" width="720" alt="Trang bán hàng: người mua thêm bánh và đồ uống vào giỏ, mở trang đặt hàng 3 bước và điền thông tin nhận hàng"></p>
<p align="center"><sub>Trang bán hàng với cửa hàng mẫu (sản phẩm thử, ảnh CC0).</sub></p>

## Triển khai

Chọn một trong hai cách, kết quả như nhau.

### Cách 1: Vercel (serverless, không phải lo máy chủ)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftanthanhkid%2Ftrinity&root-directory=apps/web&repository-name=trinity&env=JWT_SECRET,SERVICE_SECRET,CRON_SECRET,SEED_ADMIN_EMAIL,SEED_ADMIN_PASSWORD,INTEGRATIONS_MCP_ENABLED,INTEGRATIONS_SECRET_KEY&envDescription=Secrets%3A%20openssl%20rand%20-hex%2032.%20INTEGRATIONS_MCP_ENABLED%3Dtrue%20%28AI%20assistants%29.%20INTEGRATIONS_SECRET_KEY%3A%20openssl%20rand%20-base64%2032.%20Then%20the%20first%20admin%20account.%20See%20the%20README.&envLink=https%3A%2F%2Fgithub.com%2Ftanthanhkid%2Ftrinity%23deploy&products=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

Nút này sao chép repo vào GitHub của bạn, tạo project Vercel với **Root Directory `apps/web`**, hỏi các biến môi trường bên dưới và đề nghị thêm cơ sở dữ liệu **Neon Postgres**. Repo được tạo với tên `trinity`; nếu tài khoản của bạn đã có repo trùng tên, hãy đổi tên ở bước đầu của form.

Trước khi điền form:

1. **Bấm "Add Neon" trước.** Các ô biến môi trường bị khoá cho tới khi thêm xong cơ sở dữ liệu.
2. **Tắt Neon Auth** khi Neon đề nghị. Trinity có đăng nhập riêng, không dùng; để bật chỉ sinh thêm các biến `NEON_AUTH_*` không dùng tới.
3. **Chọn region gần người dùng** cho cả cơ sở dữ liệu Neon lẫn Vercel function (Project Settings → Functions → Function Region), ví dụ Singapore (`sin1`) cho Việt Nam. Mặc định là Washington (`iad1`), khiến lần gọi đầu từ Việt Nam mất khoảng 5 giây. Đặt cơ sở dữ liệu và function cùng một region.
4. Sinh khoá trên máy bạn bằng `openssl rand -hex 32` (và `openssl rand -base64 32` cho `INTEGRATIONS_SECRET_KEY`), đặt `INTEGRATIONS_MCP_ENABLED` là `true`. Cả hai đều bắt buộc: workspace mới được dựng qua trợ lý AI của bạn, thiếu chúng thì không qua được màn *Bắt đầu*. Lỡ quên thì đặt ở Project Settings → Environment Variables rồi **deploy lại**.

Mỗi lần build, Vercel cài workspace, build, chạy migration và tạo tài khoản admin đầu tiên (đều idempotent, deploy lại không sao). Không phải chạy thêm gì.

Biến môi trường (Project Settings → Environment Variables, hoặc form của nút):

| Biến | Bắt buộc | Lấy ở đâu |
|---|---|---|
| `DATABASE_URL` | có | Tích hợp Neon tự thêm (Vercel → Storage → Neon). Postgres 14+ nào cũng được. Nếu nhà cung cấp có thêm URL không qua pooler, đặt vào `DATABASE_URL_UNPOOLED`: dùng cho migration |
| `JWT_SECRET` | có | `openssl rand -hex 32` |
| `SERVICE_SECRET` | có | `openssl rand -hex 32` |
| `CRON_SECRET` | có | `openssl rand -hex 32` (bảo vệ endpoint việc nền hằng ngày mà Vercel Cron gọi) |
| `SEED_ADMIN_EMAIL` | nên đặt | Email admin đầu tiên (mặc định `admin@example.com`) |
| `SEED_ADMIN_PASSWORD` | nên đặt | Mật khẩu admin đầu tiên. Để trống thì hệ thống sinh ngẫu nhiên và **in một lần trong log build** (Deployments → bản build → tìm "Generated password"). Không bao giờ có mật khẩu mặc định cố định. Log build ai trong project cũng xem được, nên **hãy tự đặt `SEED_ADMIN_PASSWORD`** và đổi sau lần đăng nhập đầu |
| `SEED_DEMO_DATA` | không | `true` để thêm vài khách mẫu (mặc định `false`; muốn dữ liệu demo thì đặt `SEED_DEMO_DATA=true`) |
| `INTEGRATIONS_MCP_ENABLED` | có (nút sẽ hỏi) | `true` bật MCP server có sẵn (URL MCP: `https://<tên-miền>/api/v1/mcp`) |
| `INTEGRATIONS_PUBLIC_BASE_URL` | cho tên miền riêng | Trên Vercel tự lấy hostname production do nền tảng cấp (`VERCEL_PROJECT_PRODUCTION_URL`, không bao giờ lấy từ header Host), nên chỉ đặt khi dùng tên miền riêng; **ở mọi nơi khác là bắt buộc** nếu bật MCP/OAuth, ví dụ `https://crm.example.com` |
| `INTEGRATIONS_SECRET_KEY` | có (nút sẽ hỏi) | `openssl rand -base64 32` (phải là base64 của 32 byte; là khoá riêng, không suy ra từ `JWT_SECRET`). Giữ cẩn thận: mất khoá là không đọc lại được secret webhook và token OAuth đã lưu |

Triển khai bằng dòng lệnh thay cho nút (clone mới là đủ). Chạy mọi lệnh ở **thư mục gốc repo** (Root Directory của project là `apps/web`, nhưng CLI phải tải lên cả monorepo):

```bash
git clone https://github.com/tanthanhkid/trinity.git && cd trinity
vercel link --yes --project my-trinity                     # tạo project
vercel api -X PATCH /v9/projects/my-trinity -F rootDirectory=apps/web   # hoặc: Settings > General > Root Directory
vercel api -X PATCH /v9/projects/my-trinity -F serverlessFunctionRegion=sin1   # chạy gần người dùng (mặc định iad1 = Washington)
vercel integration add neon                                # hoặc thêm Postgres bất kỳ rồi tự đặt DATABASE_URL
openssl rand -hex 32 | vercel env add JWT_SECRET production --sensitive
openssl rand -hex 32 | vercel env add SERVICE_SECRET production --sensitive
openssl rand -hex 32 | vercel env add CRON_SECRET production --sensitive
printf '%s' you@example.com | vercel env add SEED_ADMIN_EMAIL production
printf '%s' 'mat-khau-dai' | vercel env add SEED_ADMIN_PASSWORD production --sensitive
printf true | vercel env add INTEGRATIONS_MCP_ENABLED production       # để nối trợ lý AI
openssl rand -base64 32 | tr -d '\n' | vercel env add INTEGRATIONS_SECRET_KEY production --sensitive
vercel deploy --prod
```

Đã thử trên tài khoản Vercel mới (15/10/2026): khoảng 4 phút từ lúc clone tới lúc đăng nhập, phần lớn là lần build đầu.

- `vercel link` ghi file `.env.local` (token Vercel ngắn hạn) và thêm nó vào `.gitignore`; `vercel integration add neon` còn ghi file skill cho agent (`.agents/`, `.claude/`, `skills-lock.json`). Các file này đều được git bỏ qua, xoá đi cũng được.
- Tạo Neon bằng dòng lệnh thì cơ sở dữ liệu nằm ở vùng mặc định và có bật Neon Auth (thêm biến `NEON_AUTH_*` không dùng tới, vô hại). Muốn chọn vùng cho cơ sở dữ liệu thì thêm Neon trong bảng điều khiển Vercel (Storage).
- Hai dòng `INTEGRATIONS_*` là bắt buộc. Workspace mới được dựng qua trợ lý AI của bạn, thiếu chúng thì workspace đứng mãi ở màn "Bắt đầu". Lỡ quên thì thêm vào rồi deploy lại.

Rồi mở URL production và đăng nhập bằng tài khoản admin ở trên. Lưu ý:

- Admin đầu tiên chỉ được tạo khi chưa tồn tại; deploy lại không bao giờ ghi đè mật khẩu.
- Workspace mới cố ý bắt đầu trống: thanh bên chỉ có *Hoạt động AI* và *Cài đặt* cho tới khi trợ lý AI dựng workspace từ màn *Bắt đầu*. Sau đó bộ cơ bản bật sẵn, phần còn lại là công tắc ở Cài đặt → *Tính năng*; ví dụ Zalo OA chưa bật thì trả 403. Cài đặt chia nhóm *Tính năng & Kết nối*, *Khách hàng*, *Công ty & Nhân sự*, *Cá nhân*; mục nào thuộc tính năng đang tắt thì ẩn.
- Trên Vercel, API chạy trong chính app Next.js (một hàm, giới hạn 60 giây). File tải lên cần object storage: đặt `STORAGE_DRIVER=vercel-blob` với token Vercel Blob, hoặc driver tương thích S3 (xem `.env.example`). Thông báo dùng polling thay cho WebSocket. Tiện ích (sandbox Deno, trang "Chương trình con") và tính năng dùng Redis cần máy chủ chạy liên tục, hãy dùng Cách 2.

### Cách 2: Tự cài bằng Docker Compose

Cần Docker có Compose. Lần build đầu trên laptop mất khoảng 5 phút.

```bash
git clone https://github.com/tanthanhkid/trinity.git
cd trinity
./install.sh --up
```

`install.sh` tạo `.env` từ `.env.example` với các secret và mật khẩu admin ngẫu nhiên (không bao giờ ghi đè `.env` có sẵn nên chạy lại an toàn), in thông tin admin một lần, rồi chạy `docker compose up --build -d`. Mở http://localhost:3000 và đăng nhập bằng tài khoản admin vừa in. Mặc định không nạp dữ liệu demo; muốn dữ liệu demo thì đặt `SEED_DEMO_DATA=true` trong `.env` (hoặc chạy `SEED_DEMO_DATA=true ./install.sh`) trước lần khởi động đầu.

Cách thủ công: `cp .env.example .env`, thay mọi giá trị `change-me-*` (`openssl rand -hex 32`), rồi `docker compose up --build -d`. Nếu `SEED_ADMIN_PASSWORD` để trống, mật khẩu sinh ra được in ở `docker compose logs migrate`.

Mỗi bản phát hành gắn tag đẩy sẵn image lên GitHub Container Registry (`ghcr.io/tanthanhkid/trinity-api`, `ghcr.io/tanthanhkid/trinity-web`). Chi tiết ở [docs/deployment.md](docs/deployment.md).

Để trợ lý AI điều khiển Trinity, đặt `INTEGRATIONS_MCP_ENABLED=true`, một `INTEGRATIONS_PUBLIC_BASE_URL` công khai và `INTEGRATIONS_SECRET_KEY` trong `.env`, rồi làm theo [docs/integrations](docs/integrations/).

Phát triển không dùng Docker: `pnpm install && pnpm dev` (cần Node 22, Postgres và Redis chạy cục bộ).

## Vì sao mình làm Trinity

> *Mình là Thành. Ngày nào mình cũng làm phần mềm cùng AI, và mình thấy các doanh nghiệp nhỏ ngập trong menu với bảng tính. Nên mình làm ra hệ thống mình muốn có: chỉ cần nói với AI việc cần làm. Mình mở miễn phí để ai cũng điều hành doanh nghiệp được theo cách này.* — Trần Tấn Thành

## Cộng đồng

- 📺 YouTube: [Lập trình với AI](https://www.youtube.com/@ltvaicom), hướng dẫn tiếng Việt, làm phần mềm cùng AI
- 🎵 TikTok: [@laptrinhvoiai](https://www.tiktok.com/@laptrinhvoiai)
- 𝕏 X: [@trntnthnh](https://x.com/trntnthnh), tin phát hành
- 💬 Hỏi đáp, ý tưởng, khoe cách dùng: [GitHub Discussions](../../discussions)
- 🐛 Báo lỗi: [GitHub Issues](../../issues)
- 🔒 Lỗ hổng bảo mật: báo riêng theo [SECURITY.md](SECURITY.md), đừng đăng issue công khai

## Giấy phép

Trinity dùng giấy phép **[AGPL-3.0](LICENSE)**: dùng, sửa, tự cài miễn phí. Nếu bạn cho người khác dùng bản đã sửa qua mạng, bạn phải công khai phần sửa theo cùng giấy phép.

Muốn nhúng Trinity vào sản phẩm đóng mã hoặc không muốn ràng buộc AGPL? Có **giấy phép thương mại**, xem [COMMERCIAL.md](COMMERCIAL.md).

"Trinity" và logo Trinity là nhãn hiệu, xem [TRADEMARK.md](TRADEMARK.md).
