"use client"

import { getApiErrorMessage } from "@/lib/api-client"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Loader2, Trash2, Plus, Search } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  useTeamMembers,
  useAddTeamMembers,
  useRemoveTeamMember,
  type Team,
} from "@/hooks/use-teams"
import { useAllEmployees } from "@/hooks/use-employees"

/**
 * Quản lý thành viên 1 Team — gán/bỏ nhân viên (MỌI vai trò) trực tiếp vào team
 * (employees.team_id). Không đụng phân quyền (manager_id) — Team chỉ là lớp tổ chức.
 */
export function TeamMembersDialog({
  team,
  open,
  onOpenChange,
}: {
  team: Team | null
  open: boolean
  onOpenChange: (o: boolean) => void
}): React.ReactElement | null {
  const teamId = team?.id ?? null
  const { data: members = [], isLoading } = useTeamMembers(open ? teamId : null)
  const { data: allEmployees = [] } = useAllEmployees()
  const add = useAddTeamMembers()
  const remove = useRemoveTeamMember()
  const [search, setSearch] = useState("")

  const memberIds = useMemo(
    () => new Set(members.map((m) => m.user_id)),
    [members],
  )
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allEmployees
      .filter((e) => !memberIds.has(e.user_id))
      .filter(
        (e) =>
          !q ||
          (e.full_name ?? "").toLowerCase().includes(q) ||
          (e.email ?? "").toLowerCase().includes(q),
      )
      .slice(0, 50)
  }, [allEmployees, memberIds, search])

  if (!team) return null

  const handleAdd = (userId: number) => {
    add.mutate(
      { teamId: team.id, userIds: [userId] },
      {
        onSuccess: () => toast.success("Đã thêm vào team"),
        onError: (e: unknown) => toast.error(getApiErrorMessage(e, "Thêm thất bại")),
      },
    )
  }
  const handleRemove = (userId: number) => {
    remove.mutate(
      { teamId: team.id, userId },
      {
        onSuccess: () => toast.success("Đã gỡ khỏi team"),
        onError: (e: unknown) => toast.error(getApiErrorMessage(e, "Gỡ thất bại")),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-sm:max-h-[85dvh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate">Thành viên — {team.name}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1">
          {/* Đang thuộc team */}
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Đang thuộc team ({members.length})
            </p>
            {isLoading ? (
              <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Đang tải...
              </div>
            ) : members.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">Chưa có thành viên.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {members.map((m) => (
                  <li key={m.user_id} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">
                        {m.full_name ?? m.email ?? `NV #${m.user_id}`}
                      </p>
                      {m.email && (
                        <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                      )}
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 shrink-0"
                      onClick={() => handleRemove(m.user_id)}
                      disabled={remove.isPending}
                      title="Gỡ khỏi team"
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Thêm thành viên */}
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Thêm thành viên (mọi vai trò)
            </p>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm theo tên hoặc email..."
                className="pl-8 max-sm:h-11"
              />
            </div>
            <ul className="mt-2 max-h-56 max-sm:max-h-none divide-y overflow-y-auto rounded-md border">
              {candidates.length === 0 ? (
                <li className="px-3 py-2 text-sm text-muted-foreground">
                  Không có nhân viên phù hợp.
                </li>
              ) : (
                candidates.map((e) => (
                  <li key={e.user_id} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">
                        {e.full_name ?? e.email ?? `NV #${e.user_id}`}
                      </p>
                      {e.email && (
                        <p className="truncate text-xs text-muted-foreground">{e.email}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0 gap-1"
                      onClick={() => handleAdd(e.user_id)}
                      disabled={add.isPending}
                    >
                      <Plus className="size-3.5" /> Thêm
                    </Button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
