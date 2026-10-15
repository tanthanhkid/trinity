import type { Metadata } from "next"
import { LegalPage, legalContact } from "@/components/legal-page"

export const metadata: Metadata = { title: "Chính sách quyền riêng tư — Trinity" }
export const dynamic = "force-dynamic"

export default function PrivacyPage() {
  const contact = legalContact()
  return (
    <LegalPage title="Chính sách quyền riêng tư" updated="14/10/2026">
      <p>
        Trinity là phần mềm quản lý khách hàng (CRM) mã nguồn mở. Mỗi công ty dùng Trinity trên một bản cài riêng; dữ liệu nằm trong cơ sở dữ liệu của
        bản cài đó. Trang này nói rõ Trinity nhận gì từ các mạng xã hội (Facebook, YouTube, TikTok) khi bạn liên kết kênh, dùng vào việc gì và cách xoá.
      </p>

      <h2>Dữ liệu Trinity nhận khi bạn liên kết kênh</h2>
      <ul>
        <li>Mã định danh, tên và ảnh đại diện của trang / kênh / tài khoản bạn chọn liên kết.</li>
        <li>Mã truy cập (access token, refresh token) mà mạng xã hội cấp, để đăng bài và trả lời khách thay bạn.</li>
        <li>Mã bài và đường dẫn của những bài Trinity đã đăng, để hiện trạng thái trong lịch đăng.</li>
      </ul>

      <h2>Dữ liệu từ Trang Facebook (Fanpage) của bạn</h2>
      <p>Khi công ty bạn liên kết một Trang Facebook và bật các tính năng tương ứng, Trinity nhận thêm:</p>
      <ul>
        <li>
          <b>Tin nhắn Messenger</b> mà khách gửi tới Trang: nội dung tin, thời gian, mã người gửi trong phạm vi Trang và tên hiển thị của họ.
        </li>
        <li>
          <b>Bình luận trên bài viết của Trang</b>: nội dung bình luận, thời gian, mã và tên người bình luận, bài viết được bình luận. Nếu bình luận có số
          điện thoại, Trinity lấy số đó để lưu vào hồ sơ khách.
        </li>
        <li>Thông tin khách để lại trong biểu mẫu quảng cáo của Trang (nếu công ty bạn bật tính năng nhận khách từ quảng cáo).</li>
      </ul>
      <p>Trinity không đọc tin nhắn cá nhân của bạn, danh sách bạn bè, người theo dõi hay nội dung ngoài các Trang bạn đã liên kết.</p>

      <h2>Dùng vào việc gì</h2>
      <ul>
        <li>Đăng bài (chữ, ảnh, video) mà người dùng trong công ty bạn soạn hoặc hẹn giờ, lên đúng kênh họ chọn.</li>
        <li>Hiện trạng thái từng bài: đã đăng, lỗi, cần liên kết lại.</li>
        <li>Hiện tin nhắn Messenger trong Hộp thư của Trinity để nhân viên trả lời khách, và ghi khách vào danh sách khách hàng của công ty.</li>
        <li>
          Tự trả lời bình luận theo luật do công ty bạn đặt: khi bình luận chứa từ khoá đã chọn, Trinity trả lời công khai dưới bình luận, gửi một tin
          nhắn riêng cho người bình luận (mỗi bình luận nhiều nhất một tin), và có thể ẩn bình luận chứa số điện thoại để bảo vệ thông tin của khách.
          Trinity chỉ làm đúng những luật công ty bạn đã bật.
        </li>
        <li>Cho trợ lý AI mà công ty bạn kết nối đọc danh sách bình luận và luật trả lời, khi người dùng có quyền yêu cầu.</li>
      </ul>
      <p>Trinity không bán, không chia sẻ dữ liệu này cho bên thứ ba và không dùng để quảng cáo.</p>

      <h2>Lưu trữ và bảo vệ</h2>
      <p>
        Mã truy cập được mã hoá (AES-256-GCM) trước khi lưu và không bao giờ trả ra giao diện hay API. Chỉ người có quyền quản lý kênh trong công ty mới
        liên kết hoặc gỡ được kênh. Tin nhắn và bình luận chỉ người trong công ty có quyền tương ứng mới xem được.
      </p>

      <h2 id="xoa-du-lieu">Xoá dữ liệu</h2>
      <ul>
        <li>Trong Trinity: gỡ kênh hoặc gỡ Trang trong phần Kết nối. Mã truy cập bị xoá ngay; bài hẹn giờ chưa đăng trên kênh đó bị huỷ; Trinity ngừng nhận tin nhắn và bình luận của Trang đó.</li>
        <li>Trên mạng xã hội: thu hồi quyền của ứng dụng trong phần cài đặt ứng dụng của tài khoản (ví dụ Facebook › Cài đặt › Doanh nghiệp tích hợp).</li>
        <li>
          Khách đã nhắn tin hoặc bình luận trên Trang của một công ty dùng Trinity, muốn xoá dữ liệu của mình: liên hệ công ty đó, hoặc {contact}. Tin
          nhắn, bình luận và hồ sơ khách liên quan sẽ được xoá khỏi bản cài Trinity của công ty đó.
        </li>
        <li>Muốn xoá cả lịch sử bài đã đăng trong Trinity: liên hệ {contact}.</li>
      </ul>

      <h2>Liên hệ</h2>
      <p>Mọi câu hỏi về quyền riêng tư: {contact}.</p>

      <h2 id="english" lang="en">English summary</h2>
      <div lang="en" className="space-y-3">
        <p>
          Trinity is an open-source CRM. Each company runs its own Trinity installation and its data stays in that installation&apos;s database.
        </p>
        <p>
          <b>What we receive.</b> When a company connects a social channel: the page/channel ID, name and picture, and the access tokens issued by the
          network. When a company connects a Facebook Page: Messenger messages sent to the Page, comments on the Page&apos;s posts (text, time, commenter ID
          and name, the post), a phone number if the commenter wrote one, and lead-form entries if lead ads are enabled. We do not read personal inboxes,
          friend lists or followers.
        </p>
        <p>
          <b>How we use it.</b> To publish posts the company&apos;s staff wrote or approved; to show Page messages in Trinity&apos;s inbox so staff can
          reply; to save customers to the company&apos;s contact list; and to apply the comment rules the company switched on (a public reply, at most one
          private reply per comment, and optionally hiding comments that contain a phone number). We never sell or share this data and never use it for
          advertising.
        </p>
        <p>
          <b>Security.</b> Access tokens are encrypted with AES-256-GCM and never returned by the UI or API. Only staff with the matching permission can
          see messages and comments.
        </p>
        <p>
          <b>Deletion.</b> Disconnecting a Page or channel in Trinity deletes its tokens immediately and stops message and comment collection. You can
          also remove the app in Facebook › Settings › Business integrations. People who messaged or commented on a Page can ask the Page owner, or{" "}
          {contact}, to delete their messages, comments and contact record.
        </p>
      </div>
    </LegalPage>
  )
}
