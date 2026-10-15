import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import type { AxiosError } from "axios"
import apiClient from "@/lib/api-client"
import { todayVn } from "@/lib/format"
import { buildContactFilterParams, type ContactFilters } from "@/hooks/use-contacts"

/** Trigger browser download from blob response */
function downloadBlob(data: BlobPart): void {
  const blob = new Blob([data], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `khach-hang-${todayVn()}.xlsx`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * Xuất Excel danh bạ trong phạm vi RBAC, ÁP bộ lọc UI đang chọn:
 * khi người dùng chọn Giai đoạn/Nguồn/Dự án... để thu hẹp phạm vi rồi xuất, file
 * chỉ gồm khách khớp bộ lọc (không xuất đầy đủ rồi dính trần 20.000 dòng oan).
 * Dùng CHUNG `buildContactFilterParams` với `useContacts` (list) để
 * export luôn khớp với đúng bộ lọc đang hiển thị trên bảng — KHÔNG forward
 * `sort_by`/`sort_order` (export luôn tự sắp xếp trình bày Phòng ban → Team →
 * NV phụ trách → Khách hàng). BE tự scope RBAC qua `buildContactListWhere`.
 */
export function useContactsExport() {
  const mutation = useMutation({
    mutationFn: async (filters: ContactFilters) => {
      const params = buildContactFilterParams(filters)
      const res = await apiClient.get("/contacts/export", {
        params,
        responseType: "blob",
      })
      return res.data as BlobPart
    },
    onSuccess: (data) => {
      downloadBlob(data)
      toast.success("Xuất file thành công")
    },
    onError: (error: unknown) => {
      if ((error as AxiosError).response?.status === 403) {
        toast.error("Tài khoản của bạn không có quyền xuất Excel khách hàng.")
        return
      }
      toast.error("Không thể xuất file. Vui lòng thử lại sau.")
    },
  })

  return {
    exportContacts: mutation.mutate,
    isExporting: mutation.isPending,
  }
}
