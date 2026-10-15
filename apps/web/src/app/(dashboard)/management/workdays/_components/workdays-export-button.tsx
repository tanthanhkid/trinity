"use client"

import { useState } from "react"
import { Download } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import apiClient from "@/lib/api-client"

interface WorkdaysExportButtonProps {
  dateFrom: string
  dateTo: string
  /** lọc Team/Phòng ban/Chức danh đang xem trên bảng — forward xuống Excel để KHỚP dữ liệu UI. */
  teamId?: number
  department?: string
  jobTitleId?: number
}

export function WorkdaysExportButton({
  dateFrom,
  dateTo,
  teamId,
  department,
  jobTitleId,
}: WorkdaysExportButtonProps) {
  const [loading, setLoading] = useState(false)

  async function handleExport() {
    setLoading(true)
    try {
      const res = await apiClient.get<Blob>("/management/attendance/export", {
        params: {
          date_from: dateFrom,
          date_to: dateTo,
          team_id: teamId,
          department,
          job_title_id: jobTitleId,
        },
        responseType: "blob",
      })
      const blob = res.data
      if (!blob || blob.size === 0) {
        toast.error("Không có dữ liệu để xuất")
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `ngay-cong_${dateFrom}_${dateTo}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch {
      toast.error("Xuất file thất bại, thử lại sau")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleExport} disabled={loading}>
      <Download className="mr-1.5 h-4 w-4" />
      {loading ? "Đang xuất..." : "Xuất Excel"}
    </Button>
  )
}
