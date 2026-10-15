import { ShieldAlert } from "lucide-react"

export interface ForbiddenProps {
  /** Câu phụ giải thích thêm (tuỳ chọn) — vd tên quyền còn thiếu. */
  message?: string
}

/**
 * Trang/khối nội dung khi user không đủ quyền truy cập (spec §5.4 — middleware
 * chỉ kiểm phiên, KHÔNG chặn theo quyền; trang tự render `<Forbidden />` khi
 * `usePermissions()` báo thiếu quyền). BE vẫn là tuyến chặn dữ liệu thật.
 */
export function Forbidden({ message }: ForbiddenProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed p-10 text-center text-muted-foreground">
      <ShieldAlert className="size-8 text-amber-500" />
      <p className="font-medium text-foreground">Bạn không có quyền truy cập trang này</p>
      {message && <p className="text-sm">{message}</p>}
    </div>
  )
}
