import type { Metadata } from "next"
import { LegalPage, legalContact } from "@/components/legal-page"

export const metadata: Metadata = { title: "Điều khoản sử dụng — Trinity" }
export const dynamic = "force-dynamic"

export default function TermsPage() {
  const contact = legalContact()
  return (
    <LegalPage title="Điều khoản sử dụng" updated="14/10/2026">
      <p>
        Trinity là phần mềm quản lý khách hàng (CRM) mã nguồn mở. Khi dùng bản cài Trinity này, bạn đồng ý với các điều khoản dưới đây.
      </p>

      <h2>Tài khoản</h2>
      <p>Tài khoản do quản trị viên công ty bạn cấp. Bạn giữ mật khẩu của mình và chịu trách nhiệm về thao tác thực hiện bằng tài khoản đó.</p>

      <h2>Đăng bài lên mạng xã hội</h2>
      <ul>
        <li>Trinity chỉ đăng nội dung do người dùng soạn hoặc đồng ý (kể cả nội dung trợ lý AI soạn theo yêu cầu của người dùng), lên đúng kênh được chọn.</li>
        <li>Người đăng chịu trách nhiệm về nội dung và phải tuân thủ điều khoản của từng mạng xã hội (Facebook, YouTube, TikTok).</li>
        <li>Mạng xã hội có thể từ chối hoặc gỡ bài theo chính sách của họ; Trinity hiện lý do lỗi khi mạng trả về.</li>
      </ul>

      <h2>Tin nhắn và bình luận trên Trang Facebook</h2>
      <ul>
        <li>Công ty liên kết Trang phải là quản trị viên của Trang đó và chịu trách nhiệm về nội dung trả lời khách, kể cả câu trả lời tự động theo luật công ty đặt.</li>
        <li>Luật tự trả lời bình luận chỉ chạy khi công ty bật; mỗi bình luận nhận nhiều nhất một tin nhắn riêng. Không dùng tính năng này để gửi tin quảng cáo hàng loạt hay làm phiền người dùng.</li>
        <li>Công ty phải tôn trọng yêu cầu xoá dữ liệu của khách đã nhắn tin hoặc bình luận trên Trang.</li>
      </ul>

      <h2>Dữ liệu</h2>
      <p>
        Cách Trinity xử lý dữ liệu từ mạng xã hội được nêu trong <a className="text-primary hover:underline" href="/privacy">Chính sách quyền riêng tư</a>.
      </p>

      <h2>Giới hạn trách nhiệm</h2>
      <p>
        Phần mềm được cung cấp theo hiện trạng. Bài đăng có thể chậm hoặc lỗi khi mạng xã hội gián đoạn hay thay đổi API; Trinity thử lại và báo trạng thái
        nhưng không bảo đảm mọi bài lên đúng giờ.
      </p>

      <h2>Liên hệ</h2>
      <p>{contact}.</p>
    </LegalPage>
  )
}
