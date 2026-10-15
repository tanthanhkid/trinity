"use client"

import { getApiErrorMessage } from "@/lib/api-client"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Building2, Plus, Trash2, Loader2, Save } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useDepartments, useUpdateDepartments } from "@/hooks/use-departments"
import { usePermissions } from "@/lib/rbac"
import { SettingsSectionActions } from "./settings-section-header"

export function SettingsDepartments(): React.ReactElement {
  const canEdit = usePermissions().can("org.manage")
  const departments = useDepartments()
  const update = useUpdateDepartments()

  const [items, setItems] = useState<string[]>(departments)
  // Seed từ server 1 lần khi tải xong — bail-out chống render storm.
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current || departments.length === 0) return
    seededRef.current = true
    setItems(departments)
  }, [departments])

  const handleChange = (idx: number, value: string) => {
    setItems((prev) => prev.map((d, i) => (i === idx ? value : d)))
  }
  const handleRemove = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx))
  }
  const handleAdd = () => {
    setItems((prev) => [...prev, ""])
  }
  const handleSave = () => {
    const cleaned = items.map((d) => d.trim()).filter(Boolean)
    if (cleaned.length === 0) {
      toast.error("Cần ít nhất 1 phòng ban")
      return
    }
    update.mutate(cleaned, {
      onSuccess: (data) => {
        setItems(data.departments)
        toast.success("Đã lưu danh sách phòng ban")
      },
      onError: (e) => toast.error(getApiErrorMessage(e, "Lưu thất bại")),
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="size-5 text-[var(--color-app-primary-ink)]" />
          Phòng ban
        </CardTitle>
        <CardDescription>
          Danh sách phòng ban dùng chung cho Quản lý nhân viên, Hợp đồng, Tuyển dụng
          và bộ lọc thống kê. Sửa ở đây sẽ áp dụng cho mọi nơi.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có phòng ban nào.</p>
          ) : (
            items.map((d, idx) => (
              <div key={idx} className="flex items-center gap-2 max-sm:gap-3">
                <Input
                  value={d}
                  onChange={(e) => handleChange(idx, e.target.value)}
                  placeholder="Tên phòng ban"
                  disabled={!canEdit}
                  maxLength={100}
                />
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    onClick={() => handleRemove(idx)}
                    title="Xoá phòng ban"
                    aria-label="Xoá phòng ban"
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
        {canEdit ? (
          <div className="flex items-center justify-between pt-1">
            <SettingsSectionActions mobile="bar">
              <Button
                type="button"
                onClick={handleSave}
                disabled={update.isPending}
                className="gap-1"
              >
                {update.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                Lưu phòng ban
              </Button>
            </SettingsSectionActions>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={handleAdd}
              className="gap-1"
            >
              <Plus className="size-4" /> Thêm phòng ban
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Bạn không có quyền chỉnh sửa danh sách phòng ban.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
