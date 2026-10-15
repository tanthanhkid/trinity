"use client"

import { useState } from "react"
import { Download } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import apiClient from "@/lib/api-client"

interface MonthlyGridExportButtonProps {
  dateFrom: string
  dateTo: string
  /**
   * Team/Phòng ban đang lọc — forward xuống BE. Chỉ hai bộ lọc này đi theo: ô tìm kiếm, chức vụ, trạng thái
   * lọc phía client trên bảng nên file Excel có thể nhiều người hơn bảng đang xem.
   */
  teamId?: number
  department?: string
}

export function MonthlyGridExportButton({
  dateFrom,
  dateTo,
  teamId,
  department,
}: MonthlyGridExportButtonProps) {
  const [loading, setLoading] = useState(false)

  async function handleExport() {
    setLoading(true)
    try {
      const res = await apiClient.get<Blob>("/management/attendance/workdays-matrix/export", {
        params: {
          date_from: dateFrom,
          date_to: dateTo,
          team_id: teamId,
          department,
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
      a.download = `bang-cong-thang_${dateFrom}_${dateTo}.xlsx`
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
    <Button variant="outline" size="sm" className="h-9" onClick={handleExport} disabled={loading}>
      <Download className="mr-1.5 h-4 w-4" />
      {loading ? "Đang xuất..." : "Xuất Excel"}
    </Button>
  )
}
