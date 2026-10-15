"use client"

import { getApiErrorMessage } from "@/lib/api-client"
import { useState } from "react"
import { toast } from "sonner"
import { Users2, Plus, Trash2, Loader2, Pencil, Users, MoreHorizontal } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import {
  useTeams,
  useCreateTeam,
  useUpdateTeam,
  useDeleteTeam,
  type Team,
} from "@/hooks/use-teams"
import { useDepartments } from "@/hooks/use-departments"
import { useAllEmployees } from "@/hooks/use-employees"
import { usePermissions } from "@/lib/rbac"
import { SettingsSectionActions } from "./settings-section-header"
import { TeamMembersDialog } from "./team-members-dialog"
import { ManagerSelectCombobox } from "./manager-select-combobox"

const NO_DEPT = "__none__"

type FormState = { name: string; department: string; team_lead_id: string }

export function SettingsTeams(): React.ReactElement {
  const canEdit = usePermissions().can("org.manage")

  const { data: teams = [], isLoading } = useTeams()
  const departments = useDepartments()
  const { data: allEmployees = [] } = useAllEmployees()
  // Người phụ trách = vai trò BẤT KỲ (nhãn tổ chức). Nguồn: toàn bộ nhân viên.
  const headOptions = allEmployees.map((e) => ({
    id: e.user_id,
    full_name: e.full_name ?? e.email,
  }))
  const create = useCreateTeam()
  const update = useUpdateTeam()
  const del = useDeleteTeam()

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Team | null>(null)
  const [form, setForm] = useState<FormState>({ name: "", department: "", team_lead_id: "" })
  const [membersTeam, setMembersTeam] = useState<Team | null>(null)
  const [toDelete, setToDelete] = useState<Team | null>(null)

  const openAdd = () => {
    setEditing(null)
    setForm({ name: "", department: "", team_lead_id: "" })
    setOpen(true)
  }
  const openEdit = (t: Team) => {
    setEditing(t)
    setForm({
      name: t.name,
      department: t.department ?? "",
      team_lead_id: t.team_lead_id != null ? String(t.team_lead_id) : "",
    })
    setOpen(true)
  }

  const handleSubmit = () => {
    const name = form.name.trim()
    if (!name) {
      toast.error("Nhập tên team")
      return
    }
    const dto = {
      name,
      department: form.department || null,
      team_lead_id: form.team_lead_id ? Number(form.team_lead_id) : null,
    }
    const onSuccess = () => {
      setOpen(false)
      toast.success(editing ? "Đã cập nhật team" : "Đã tạo team")
    }
    const onError = (e: unknown) => toast.error(getApiErrorMessage(e, "Lưu thất bại"))
    if (editing) {
      update.mutate({ id: editing.id, dto }, { onSuccess, onError })
    } else {
      create.mutate(dto, { onSuccess, onError })
    }
  }

  const handleDelete = () => {
    if (!toDelete) return
    del.mutate(toDelete.id, {
      onSuccess: () => {
        toast.success("Đã xoá team")
        setToDelete(null)
      },
      onError: (e: unknown) => toast.error(getApiErrorMessage(e, "Xoá thất bại")),
    })
  }

  const saving = create.isPending || update.isPending

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Users2 className="size-5 text-[var(--color-app-primary-ink)]" />
            Team
          </CardTitle>
          <CardDescription className="max-sm:hidden">
            Mỗi Team thuộc 1 Phòng ban; người phụ trách là vai trò bất kỳ. Bấm
            &quot;Thành viên&quot; để gán nhân viên (MỌI vai trò) vào team — chỉ để
            tổ chức/hiển thị, KHÔNG đổi phân quyền. Một phòng ban có nhiều Team.
          </CardDescription>
        </div>
        {canEdit && (
          <SettingsSectionActions mobile="fab">
            <Button type="button" onClick={openAdd} className="shrink-0 gap-1">
              <Plus className="size-4" /> Thêm Team
            </Button>
          </SettingsSectionActions>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Đang tải team...
          </div>
        ) : teams.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Chưa có team nào.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {teams.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2.5 max-sm:flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{t.name}</span>
                    {t.department && (
                      <span className="shrink-0 rounded-full border bg-muted px-2 py-0.5 text-sm text-muted-foreground">
                        {t.department}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Phụ trách: {t.team_lead_name ?? "— chưa gán —"} · {t.member_count} thành viên
                  </p>
                </div>
                {canEdit && (
                  <div className="flex shrink-0 items-center gap-1 max-sm:w-full max-sm:justify-end max-sm:gap-2">
                    <Button size="sm" variant="outline" type="button" className="h-8 gap-1" onClick={() => setMembersTeam(t)} title="Quản lý thành viên">
                      <Users className="size-4" /> Thành viên
                    </Button>
                    <Button size="icon" variant="ghost" type="button" className="size-8 max-sm:hidden" onClick={() => openEdit(t)} title="Sửa">
                      <Pencil className="size-4 text-muted-foreground" />
                    </Button>
                    <Button size="icon" variant="ghost" type="button" className="size-8 max-sm:hidden" onClick={() => setToDelete(t)} disabled={del.isPending} title="Xoá">
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                    {/* Điện thoại: Sửa/Xoá vào menu "⋯", Xoá cuối + qua ConfirmDialog. */}
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button size="icon" variant="ghost" type="button" className="sm:hidden" aria-label="Thao tác khác" />}
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem className="max-sm:min-h-11" onClick={() => openEdit(t)}>
                          <Pencil className="size-4" /> Sửa
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" className="max-sm:min-h-11" disabled={del.isPending} onClick={() => setToDelete(t)}>
                          <Trash2 className="size-4" /> Xoá
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {!canEdit && (
          <p className="mt-3 text-sm text-muted-foreground">
            Bạn không có quyền chỉnh sửa Team.
          </p>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Sửa Team" : "Thêm Team"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Tên Team *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Vd: Team Kinh doanh 1"
                maxLength={100}
              />
            </div>
            <div className="space-y-1">
              <Label>Phòng ban</Label>
              <Select
                value={form.department || NO_DEPT}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, department: v === NO_DEPT ? "" : (v ?? "") }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn phòng ban">
                    {(v) => (typeof v === "string" && v && v !== NO_DEPT ? v : "— Không —")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DEPT}>— Không —</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d} value={d}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Người phụ trách</Label>
              <ManagerSelectCombobox
                options={headOptions.map((u) => ({ id: u.id, label: u.full_name }))}
                value={form.team_lead_id || null}
                onChange={(v) => setForm((f) => ({ ...f, team_lead_id: v ?? "" }))}
                placeholder="Tìm theo tên nhân viên…"
              />
              <p className="text-sm text-muted-foreground">
                Vai trò bất kỳ — chỉ là nhãn tổ chức, không đổi phân quyền.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Huỷ
            </Button>
            <Button type="button" onClick={handleSubmit} disabled={saving || !form.name.trim()} className="gap-1">
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {editing ? "Lưu Team" : "Tạo Team"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Xoá Team"
        description={`Xoá team "${toDelete?.name ?? ""}"? Nhân viên thuộc team sẽ được gỡ khỏi team (giữ nguyên trưởng nhóm).`}
        confirmLabel="Xoá Team"
        pending={del.isPending}
        onConfirm={handleDelete}
      />

      <TeamMembersDialog
        team={membersTeam}
        open={membersTeam != null}
        onOpenChange={(o) => {
          if (!o) setMembersTeam(null)
        }}
      />
    </Card>
  )
}
