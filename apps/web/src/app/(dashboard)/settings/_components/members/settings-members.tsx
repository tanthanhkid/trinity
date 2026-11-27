"use client"

import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ChevronDown, Crown, Link2, MoreHorizontal, RefreshCw, Search, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import apiClient from "@/lib/api-client"
import { useOrgFeatures } from "@/hooks/use-org-features"
import { apiErrorMessage } from "../roles/use-roles-api"
import { SettingsTeams } from "../settings-teams"
import { INVITES_KEY, InviteByLinkButton } from "../user-invitations"
import {
  buildRows,
  ROLE_LABEL,
  rowActions,
  STATUS_LABEL,
  usedSeats,
  type InviteLite,
  type MemberRow,
  type MembersPayload,
  type RowAction,
} from "./member-rows"
import {
  ChangeRoleDialog,
  LockDialog,
  MEMBERS_KEY,
  RemoveMemberDialog,
  ResetPasswordDialog,
  TransferOwnerDialog,
} from "./member-dialogs"

const ACTION_LABEL: Record<RowAction, string> = {
  role: "Đổi vai trò",
  password: "Đặt lại mật khẩu",
  lock: "Tạm khoá",
  unlock: "Mở khoá",
  owner: "Chuyển quyền chủ",
  remove: "Xoá khỏi tổ chức",
}

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("vi-VN") : "")

function RoleBadge({ role }: { role: MemberRow["role"] }) {
  return (
    <Badge variant={role === "member" ? "secondary" : "soft"}>
      {role === "owner" && <Crown className="size-3" aria-hidden />}
      {ROLE_LABEL[role]}
    </Badge>
  )
}

function StatusBadge({ status }: { status: MemberRow["status"] }) {
  const variant = status === "active" ? "success" : status === "locked" || status === "invite_expired" ? "destructive" : "outline"
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>
}

/** Cài đặt › Thành viên: một danh sách duy nhất, ba vai trò cố định. */
export function SettingsMembers() {
  const qc = useQueryClient()
  const { features } = useOrgFeatures()
  const [search, setSearch] = useState("")
  const [dialog, setDialog] = useState<{ action: RowAction; row: MemberRow } | null>(null)
  const [showGroups, setShowGroups] = useState(false)

  const members = useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: async () => (await apiClient.get<MembersPayload>("/members")).data,
  })
  const data = members.data
  const canManage = data ? data.me.role !== "member" : false
  const invites = useQuery({
    queryKey: INVITES_KEY,
    enabled: canManage,
    queryFn: async () => (await apiClient.get<{ data: InviteLite[] }>("/auth/invitations")).data.data,
  })
  const revoke = useMutation({
    mutationFn: (id: number) => apiClient.post(`/auth/invitations/${id}/revoke`),
    onSuccess: () => {
      toast.success("Đã thu hồi lời mời")
      void qc.invalidateQueries({ queryKey: INVITES_KEY })
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Chưa thu hồi được lời mời")),
  })

  if (members.isLoading) {
    return <div className="rounded-[var(--radius)] border bg-card p-8 text-center text-sm text-muted-foreground">Đang tải...</div>
  }
  if (members.isError || !data) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        <span>Không tải được danh sách thành viên.</span>
        <Button variant="outline" size="sm" onClick={() => members.refetch()}>Thử lại</Button>
      </div>
    )
  }

  const all = buildRows(data, canManage ? (invites.data ?? []) : [])
  const q = search.trim().toLowerCase()
  const rows = q ? all.filter((r) => `${r.name} ${r.email ?? ""} ${ROLE_LABEL[r.role]}`.toLowerCase().includes(q)) : all
  const used = usedSeats(all)
  const full = data.max_users !== null && used >= data.max_users
  const inviteRoles = [
    ...(data.roles.admin_role_id !== null ? [{ id: data.roles.admin_role_id, name: ROLE_LABEL.admin }] : []),
    ...(data.roles.member_role_id !== null ? [{ id: data.roles.member_role_id, name: ROLE_LABEL.member }] : []),
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1 max-sm:min-w-0 max-sm:basis-full">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm theo tên hoặc email..." className="h-11 pl-9" aria-label="Tìm thành viên" />
        </div>
        <div className="text-sm text-muted-foreground" data-testid="seat-count">
          {data.max_users === null ? `${used} thành viên` : `${used} / ${data.max_users} chỗ`}
        </div>
        {canManage && <InviteByLinkButton label="Mời thành viên" roles={inviteRoles} disabled={full} />}
      </div>
      {canManage && full && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Gói hiện tại đã đủ {data.max_users} chỗ. Thu hồi lời mời hoặc xoá bớt thành viên, hoặc nâng gói để mời thêm.
        </p>
      )}

      <div className="overflow-x-auto rounded-[var(--radius)] border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Thành viên</th>
              <th className="px-4 py-2 font-medium">Vai trò</th>
              <th className="px-4 py-2 font-medium">Trạng thái</th>
              <th className="px-4 py-2 font-medium max-sm:hidden">Tham gia</th>
              <th className="w-12 px-2 py-2"><span className="sr-only">Thao tác</span></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Không có thành viên nào khớp.</td></tr>
            )}
            {rows.map((r) => {
              const actions = rowActions(r, data.me)
              return (
                <tr key={r.key}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{r.kind === "invite" ? r.email : r.name}{r.self && <span className="ml-1 text-xs font-normal text-muted-foreground">(bạn)</span>}</div>
                    {r.kind === "member" && r.email && <div className="text-xs text-muted-foreground">{r.email}</div>}
                    {r.kind === "invite" && <div className="text-xs text-muted-foreground">Hạn {fmtDate(r.date)}</div>}
                  </td>
                  <td className="px-4 py-3"><RoleBadge role={r.role} /></td>
                  <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-3 text-muted-foreground max-sm:hidden">{r.kind === "member" ? fmtDate(r.date) : ""}</td>
                  <td className="px-2 py-3 text-right">
                    {r.kind === "invite" && canManage && (
                      <div className="flex items-center justify-end gap-1">
                        <InviteByLinkButton prefill={{ email: r.email ?? "", roleId: r.roleId ?? null }} roles={inviteRoles} label="Gửi lại link" />
                        <Button variant="ghost" size="icon" aria-label={`Thu hồi lời mời ${r.email}`} disabled={revoke.isPending} onClick={() => revoke.mutate(r.id)}>
                          <X className="size-4" />
                        </Button>
                      </div>
                    )}
                    {actions.length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button size="icon" variant="ghost" type="button" aria-label={`Thao tác với ${r.name}`} />}>
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {actions.map((a) => (
                            <DropdownMenuItem key={a} variant={a === "remove" || a === "lock" ? "destructive" : undefined} className="max-sm:min-h-11" onClick={() => setDialog({ action: a, row: r })}>
                              {ACTION_LABEL[a]}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {canManage && (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Link2 className="size-3" /> Mời bằng link: nhập email, chép link gửi qua Zalo hoặc Messenger.
          <RefreshCw className="ml-2 size-3" /> Gửi lại link thì link cũ hết dùng.
        </p>
      )}

      {canManage && features.management !== false && (
        <section aria-label="Nhóm" className="rounded-[var(--radius)] border bg-card">
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium"
            aria-expanded={showGroups}
            onClick={() => setShowGroups((v) => !v)}
          >
            <span>Nhóm <span className="font-normal text-muted-foreground">(tuỳ chọn, để lọc và chia khách)</span></span>
            <ChevronDown className={`size-4 transition-transform ${showGroups ? "rotate-180" : ""}`} />
          </button>
          {showGroups && <div className="border-t p-2"><SettingsTeams /></div>}
        </section>
      )}

      {dialog?.action === "role" && <ChangeRoleDialog member={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.action === "password" && <ResetPasswordDialog member={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.action === "remove" && <RemoveMemberDialog member={dialog.row} candidates={all} meId={data.me.id} onClose={() => setDialog(null)} />}
      {dialog?.action === "owner" && <TransferOwnerDialog member={dialog.row} onClose={() => setDialog(null)} />}
      {(dialog?.action === "lock" || dialog?.action === "unlock") && (
        <LockDialog member={dialog.row} lock={dialog.action === "lock"} onClose={() => setDialog(null)} />
      )}
    </div>
  )
}
