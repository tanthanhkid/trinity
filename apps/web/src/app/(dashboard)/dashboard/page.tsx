"use client"

/* `"use client"`: trang dùng hook (`useAuth`, `usePermissions`) trong lời chào + widget theo quyền. */
import { DashboardHome } from "./_components/dashboard-home"
import { DashboardFilterProvider } from "./_components/dashboard-filter-context"
import { DashboardWidgets } from "./_components/dashboard-widgets"

/**
 * Trang chủ "AI đã làm gì hôm nay" (bố cục bản demo): lời chào + tóm tắt → thẻ số →
 * dòng thời gian AI | Cần bạn xem · Trợ lý đang kết nối → khối "Số liệu kinh doanh"
 * (biểu đồ, việc hôm nay, khách gần đây). Thân dưới = widget theo quyền
 * (`_components/widgets.ts`), KHÔNG rẽ nhánh theo vai trò. Nút "Trung tâm báo cáo"
 * nằm ở hàng lời chào (`dashboard-reports-button.tsx` tự ẩn khi không có quyền `reports.*`).
 */
export default function DashboardPage() {
  return (
    <DashboardFilterProvider>
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 pt-2 md:gap-8 md:pt-5">
        <DashboardHome />
        <DashboardWidgets />
      </div>
    </DashboardFilterProvider>
  )
}
