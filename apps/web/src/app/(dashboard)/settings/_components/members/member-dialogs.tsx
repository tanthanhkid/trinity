"use client"

import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import apiClient from "@/lib/api-client"
import { apiErrorMessage } from "../roles/use-roles-api"
import { ROLE_HINT, ROLE_LABEL, type MemberRow } from "./member-rows"

export const MEMBERS_KEY = ["members"] as const

function useRefresh() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: MEMBERS_KEY })
    void qc.invalidateQueries({ queryKey: ["users"] })
    void qc.invalidateQueries({ queryKey: ["rbac"] })
  }
}

/** Đổi giữa Quản trị và Thành viên (Chủ sở hữu không đổi được; chuyển quyền chủ có hộp riêng). */
export function ChangeRoleDialog({ member, onClose }: { member: MemberRow; onClose: () => void }) {
  const refresh = useRefresh()
  const [role, setRole] = useState<"admin" | "member">(member.role === "admin" ? "admin" : "member")
  const save = useMutation({
    mutationFn: () => apiClient.put(`/members/${member.id}/role`, { role }),
    onSuccess: () => {
      toast.success(`Đã đổi vai trò của ${member.name}`)
      refresh()
      onClose()
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Chưa đổi được vai trò")),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Đổi vai trò</DialogTitle>
          <DialogDescription>{member.name}</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label="Vai trò" className="space-y-2">
          {(["admin", "member"] as const).map((r) => (
            <label key={r} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm has-[:checked]:border-primary">
              <input type="radio" name="member-role" className="mt-1" checked={role === r} onChange={() => setRole(r)} />
              <span>
                <span className="font-medium">{ROLE_LABEL[r]}</span>
                <span className="block text-xs text-muted-foreground">{ROLE_HINT[r]}</span>
              </span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11" onClick={onClose}>Huỷ</Button>
          <Button className="h-11" disabled={save.isPending || role === member.role} onClick={() => save.mutate()}>
            {save.isPending ? "Đang lưu..." : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Đặt lại mật khẩu cho nhân viên (chưa có dịch vụ mail nên chủ/quản trị tự đặt rồi đưa lại cho họ). */
export function ResetPasswordDialog({ member, onClose }: { member: MemberRow; onClose: () => void }) {
  const [pw, setPw] = useState("")
  const save = useMutation({
    mutationFn: () => apiClient.patch(`/users/${member.id}/reset-password`, { password: pw }),
    onSuccess: () => {
      toast.success(`Đã đặt lại mật khẩu của ${member.name}. Hãy báo mật khẩu mới cho họ.`)
      onClose()
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Chưa đặt lại được mật khẩu")),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Đặt lại mật khẩu</DialogTitle>
          <DialogDescription>{member.name}. Họ sẽ bị đăng xuất ở mọi thiết bị.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="member-new-password">Mật khẩu mới</Label>
          <Input id="member-new-password" type="text" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Tối thiểu 8 ký tự" className="h-11" />
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11" onClick={onClose}>Huỷ</Button>
          <Button className="h-11" disabled={pw.length < 8 || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Đang lưu..." : "Đặt lại"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Xoá khỏi tổ chức: bắt buộc chọn người nhận khách, deal và việc của người bị xoá. */
export function RemoveMemberDialog({ member, candidates, meId, onClose }: { member: MemberRow; candidates: MemberRow[]; meId: number; onClose: () => void }) {
  const refresh = useRefresh()
  const options = candidates.filter((c) => c.kind === "member" && c.status === "active" && c.id !== member.id)
  const [to, setTo] = useState<number | null>(options.find((o) => o.id === meId)?.id ?? options[0]?.id ?? null)
  const remove = useMutation({
    mutationFn: () => apiClient.delete(`/members/${member.id}`, { data: { reassign_to: to } }),
    onSuccess: () => {
      toast.success(`Đã xoá ${member.name} khỏi tổ chức`)
      refresh()
      onClose()
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Chưa xoá được thành viên")),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && !remove.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Xoá khỏi tổ chức</DialogTitle>
          <DialogDescription>
            {member.name} sẽ không đăng nhập được nữa. Khách, deal và việc đang giao cho họ chuyển sang người bạn chọn.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="member-reassign">Chuyển dữ liệu cho</Label>
          <select
            id="member-reassign"
            value={to ?? ""}
            onChange={(e) => setTo(e.target.value ? Number(e.target.value) : null)}
            className="h-11 w-full rounded-md border bg-background px-3 text-sm"
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>{o.name}{o.self ? " (bạn)" : ""}</option>
            ))}
          </select>
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11" disabled={remove.isPending} onClick={onClose}>Huỷ</Button>
          <Button variant="destructive" className="h-11" disabled={to === null || remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? "Đang xoá..." : "Xoá thành viên"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function TransferOwnerDialog({ member, onClose }: { member: MemberRow; onClose: () => void }) {
  const refresh = useRefresh()
  const go = useMutation({
    mutationFn: () => apiClient.post("/members/transfer-owner", { user_id: member.id }),
    onSuccess: () => {
      toast.success(`${member.name} là Chủ sở hữu mới`)
      refresh()
      onClose()
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Chưa chuyển được quyền chủ")),
  })
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      tone="default"
      title="Chuyển quyền Chủ sở hữu"
      description={<>Chuyển quyền chủ cho <b>{member.name}</b>. Bạn vẫn là Quản trị nhưng không còn quản lý được gói.</>}
      confirmLabel="Chuyển quyền chủ"
      pending={go.isPending}
      onConfirm={() => go.mutate()}
    />
  )
}

export function LockDialog({ member, lock, onClose }: { member: MemberRow; lock: boolean; onClose: () => void }) {
  const refresh = useRefresh()
  const go = useMutation({
    mutationFn: () => apiClient.patch(`/users/${member.id}`, { status: lock ? "locked" : "active" }),
    onSuccess: () => {
      toast.success(lock ? `Đã tạm khoá ${member.name}` : `Đã mở khoá ${member.name}`)
      refresh()
      onClose()
    },
    onError: (e) => toast.error(apiErrorMessage(e, lock ? "Chưa khoá được tài khoản" : "Chưa mở khoá được tài khoản")),
  })
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      tone={lock ? "destructive" : "default"}
      title={lock ? "Tạm khoá thành viên" : "Mở khoá thành viên"}
      description={lock ? <><b>{member.name}</b> sẽ bị đăng xuất và không đăng nhập được cho đến khi mở khoá. Dữ liệu giữ nguyên.</> : <>Cho <b>{member.name}</b> đăng nhập lại.</>}
      confirmLabel={lock ? "Tạm khoá" : "Mở khoá"}
      pending={go.isPending}
      onConfirm={() => go.mutate()}
    />
  )
}
