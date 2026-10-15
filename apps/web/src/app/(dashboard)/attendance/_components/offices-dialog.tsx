"use client"

import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  useOffices,
  useCreateOffice,
  useUpdateOffice,
  useDeleteOffice,
  type AttendanceOffice,
} from "@/hooks/use-attendance"

function parseIps(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function OfficeRow({ office }: { office: AttendanceOffice }) {
  const [name, setName] = useState(office.name)
  const [ipsText, setIpsText] = useState(office.ips.join(", "))
  const [active, setActive] = useState(office.is_active)
  const [isDemo, setIsDemo] = useState(office.is_demo ?? false)
  const update = useUpdateOffice()
  const remove = useDeleteOffice()
  const [confirmDelete, setConfirmDelete] = useState(false)

  const dirty =
    name !== office.name ||
    ipsText !== office.ips.join(", ") ||
    active !== office.is_active ||
    isDemo !== (office.is_demo ?? false)

  return (
    <div className="rounded-xl border p-3">
      <div className="flex items-center gap-2 max-sm:flex-wrap">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tên văn phòng"
          className="h-9 max-sm:h-11"
        />
        {office.is_demo && (
          <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
            Demo
          </span>
        )}
        <label className="flex shrink-0 items-center gap-1.5 text-xs max-sm:min-h-11">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          Hoạt động
        </label>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-destructive hover:text-destructive"
          aria-label="Xoá văn phòng"
          onClick={() => setConfirmDelete(true)}
          disabled={remove.isPending}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <Input
        value={ipsText}
        onChange={(e) => setIpsText(e.target.value)}
        placeholder="Danh sách IP, cách nhau bởi dấu phẩy"
        className="mt-2 h-9 font-mono text-xs max-sm:h-11"
      />
      <label className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground max-sm:min-h-11">
        <input
          type="checkbox"
          checked={isDemo}
          onChange={(e) => setIsDemo(e.target.checked)}
        />
        Văn phòng demo (bỏ qua kiểm tra IP, chỉ để thử nghiệm — cần quyền cấu hình chấm công)
      </label>
      {dirty && (
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() =>
              update.mutate(
                { id: office.id, body: { name, ips: parseIps(ipsText), is_active: active, is_demo: isDemo } },
                {
                  onSuccess: () => toast.success("Đã lưu văn phòng."),
                  onError: () => toast.error("Lưu văn phòng thất bại."),
                },
              )
            }
          >
            Lưu
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Xoá văn phòng "${office.name}"?`}
        confirmLabel="Xoá"
        tone="destructive"
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(office.id, {
            onSuccess: () => {
              toast.success("Đã xoá văn phòng.")
              setConfirmDelete(false)
            },
            onError: () => toast.error("Xoá văn phòng thất bại."),
          })
        }
      />
    </div>
  )
}

export function OfficesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const offices = useOffices(open)
  const create = useCreateOffice()
  const [newName, setNewName] = useState("")
  const [newIps, setNewIps] = useState("")
  const [newIsDemo, setNewIsDemo] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden max-w-[95vw] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Văn phòng chấm công (IP hợp lệ)</DialogTitle>
        </DialogHeader>

        <div className="flex-1 space-y-3 overflow-y-auto px-1">
          {offices.isLoading ? (
            <p className="text-sm text-muted-foreground">Đang tải...</p>
          ) : (offices.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có văn phòng nào.</p>
          ) : (
            (offices.data ?? []).map((o) => <OfficeRow key={o.id} office={o} />)
          )}

          <div className="rounded-xl border border-dashed p-3">
            <p className="mb-2 text-sm font-medium">Thêm văn phòng mới</p>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Tên văn phòng"
              className="h-9 max-sm:h-11"
            />
            <Input
              value={newIps}
              onChange={(e) => setNewIps(e.target.value)}
              placeholder="Danh sách IP, cách nhau bởi dấu phẩy"
              className="mt-2 h-9 font-mono text-xs max-sm:h-11"
            />
            <label className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground max-sm:min-h-11">
              <input
                type="checkbox"
                checked={newIsDemo}
                onChange={(e) => setNewIsDemo(e.target.checked)}
              />
              Văn phòng demo (bỏ qua kiểm tra IP, chỉ super_admin dùng để test)
            </label>
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="outline"
                disabled={create.isPending || newName.trim().length < 2}
                onClick={() =>
                  create.mutate(
                    { name: newName.trim(), ips: parseIps(newIps), is_demo: newIsDemo },
                    {
                      onSuccess: () => {
                        toast.success("Đã thêm văn phòng.")
                        setNewName("")
                        setNewIps("")
                        setNewIsDemo(false)
                      },
                      onError: () => toast.error("Thêm văn phòng thất bại."),
                    },
                  )
                }
              >
                <Plus className="mr-1 h-4 w-4" /> Thêm
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
