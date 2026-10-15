import Image from "next/image"
import { Database, Sparkles, Sprout, UserCheck } from "lucide-react"

/**
 * 4 thông điệp theo định vị hiện tại: "Điều khiển toàn bộ doanh nghiệp từ trợ lý AI bạn yêu thích".
 *
 * 🔴 Nội dung hướng ra KHÁCH HÀNG: KHÔNG được có các chữ MCP, API, server, OAuth, token, plugin — chỉ nói lợi ích
 * bằng ngôn ngữ người dùng. Test khoá: `__tests__/login/login-brand-panel.test.tsx`.
 */
const HIGHLIGHTS = [
  { icon: Sparkles, label: "Dùng ngay trợ lý AI bạn đã có — không phải học thêm công cụ mới" },
  { icon: Database, label: "Mọi dữ liệu của doanh nghiệp về một nơi" },
  { icon: UserCheck, label: "AI làm việc trong phạm vi quyền của bạn, mọi thao tác đều có nhật ký" },
  { icon: Sprout, label: "Hệ thống tự lớn lên cùng doanh nghiệp của bạn" },
] as const

export function LoginBrandPanel() {
  // Giao diện mới (bước 4b): panel sáng/tối trung tính theo demo (`--sunken`, `--line`, `--accent-soft`) thay cho
  // gradient teal cũ. Màu viết literal vì token `[data-ui="app"]` chỉ có sau lần paint đầu.
  return (
    <div className="relative hidden overflow-hidden border-r border-[#ebebe8] bg-[#f5f5f3] text-[#1d1f23] lg:flex lg:flex-col lg:justify-between lg:p-12 dark:border-[#23252b] dark:bg-[#18191e] dark:text-[#e8e9ec]">
      <div className="relative flex items-center gap-3">
        <Image
          src="/logo/trinity-mark.png"
          alt=""
          width={220}
          height={295}
          priority
          className="h-10 w-auto dark:rounded-md dark:bg-white dark:p-1"
        />
        <span className="text-xl font-semibold tracking-tight">Trinity</span>
      </div>

      <div className="relative space-y-8">
        <div className="space-y-3">
          <h2 className="max-w-xl text-[32px] font-semibold leading-tight tracking-tight">
            Điều khiển toàn bộ doanh nghiệp
            <br />
            từ trợ lý AI bạn yêu thích.
          </h2>
          <p className="max-w-md text-base text-[#6b6f78] dark:text-[#9a9ea8]">
            Bạn nói với AI, Trinity lo phần còn lại — khách hàng, công việc và
            con người trong cùng một nơi.
          </p>
        </div>

        <ul className="space-y-3">
          {HIGHLIGHTS.map(({ icon: Icon, label }) => (
            <li key={label} className="flex items-center gap-3 text-[15px]">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#e9f2f9] text-[#285f8c] dark:bg-[#1b2733] dark:text-[#a6cbe8]">
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              {label}
            </li>
          ))}
        </ul>
      </div>

      <div className="relative text-sm text-[#6b6f78] dark:text-[#9a9ea8]">
        © {new Date().getFullYear()} Trinity. Mọi quyền được bảo lưu.
      </div>
    </div>
  )
}
