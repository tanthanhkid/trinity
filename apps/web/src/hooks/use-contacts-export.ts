import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import type { AxiosError } from "axios"
import apiClient from "@/lib/api-client"
import { todayVn } from "@/lib/format"
import { buildContactFilterParams, type ContactFilters } from "@/hooks/use-contacts"

const XLSX_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const POLL_MS = 2000
/** Trần chờ tệp nền (lease worker 5 phút × 2 lần thử + dư). */
const MAX_WAIT_MS = 15 * 60 * 1000

interface ExportStatus {
  id: number
  status: "queued" | "running" | "done" | "failed"
  progress: number
  error?: string | null
}

/** Trigger browser download from blob response */
function downloadBlob(data: BlobPart): void {
  const blob = new Blob([data], { type: XLSX_TYPE })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `khach-hang-${todayVn()}.xlsx`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Xuất nền (X15b): xếp việc `POST /exports/contacts`, hỏi tiến độ tới khi xong rồi tải tệp.
 * Không giữ kết nối dài nên không dính trần 100 giây của proxy. Máy chủ chưa có route
 * (bản Node) trả 404 ⇒ trả `null` để gọi đường xuất trực tiếp như cũ.
 */
async function exportInBackground(
  params: Record<string, unknown>,
  onProgress: (percent: number) => void,
): Promise<BlobPart | null> {
  let id: number
  try {
    const res = await apiClient.post("/exports/contacts", null, { params })
    id = (res.data as { id: number }).id
  } catch (e) {
    if ((e as AxiosError).response?.status === 404) return null
    throw e
  }
  const deadline = Date.now() + MAX_WAIT_MS
  while (Date.now() < deadline) {
    const { data } = await apiClient.get<ExportStatus>(`/exports/${id}`)
    onProgress(data.progress)
    if (data.status === "done") {
      const file = await apiClient.get(`/exports/${id}/download`, {
        responseType: "blob",
      })
      return file.data as BlobPart
    }
    if (data.status === "failed") {
      throw new Error(data.error ?? "Xuất file thất bại")
    }
    await sleep(POLL_MS)
  }
  throw new Error("Hết thời gian chờ tệp xuất")
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
      const toastId = "contacts-export"
      try {
        const bg = await exportInBackground(params, (p) =>
          toast.loading(`Đang dựng file xuất… ${p}%`, { id: toastId }),
        )
        if (bg !== null) return bg
      } finally {
        toast.dismiss(toastId)
      }
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
