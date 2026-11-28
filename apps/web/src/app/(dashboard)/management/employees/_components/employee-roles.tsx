"use client"

/**
 * Khối «Vai trò» trong hồ sơ nhân viên (thiết kế nhansu-desktop / nhansu-mobile): gán vai trò ngay ở hồ sơ.
 *
 * - Đọc vai trò đang giữ: `GET /users/:id` (`users.view`) — trả TÊN vai trò; ánh xạ sang id bằng `GET /roles`
 *   (`users.manage`/`roles.manage`), tên vai trò là duy nhất. Thiếu quyền ⇒ KHÔNG gọi API nào (khoá «không request khi thiếu quyền»).
 * - Đổi: `PUT /users/:id/roles` (`users.manage`) THAY toàn bộ tập vai trò ⇒ tập gửi đi = tập đang giữ (id thật từ máy chủ) ± một vai trò.
 *   Chưa tải xong hoặc có tên không ánh xạ được ⇒ khoá chip, tránh một lần bấm xoá mất vai trò khác.
 *   Mỗi lúc một lệnh; lỗi (vd «Phải còn ít nhất 1 Quản trị», chống tự nâng quyền) hiện nguyên lời máy chủ; Hoàn tác gửi lại tập cũ.
 * - Vai trò hệ thống chỉ Quản trị gán/bỏ được (máy chủ cũng chặn). Vai trò vẫn cấu hình ở Cài đặt → Vai trò.
 */
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { isAxiosError } from "axios"
import { toast } from "sonner"

import apiClient from "@/lib/api-client"
import { errorMessage } from "@/lib/error-messages"
import { cn } from "@/lib/utils"
import { showUndoToast } from "@/components/ui/undo-toast"
import { useRoleList, useSetUserRoles, type RoleSummary } from "@/app/(dashboard)/settings/_components/roles/use-roles-api"

interface UserDetail {
  id: number
  roles: string[]
}

/** Khoá query hồ sơ người dùng — nằm dưới `["users"]` để `useRbacInvalidate` làm mới sau khi gán. */
export const userDetailKey = (userId: number) => ["users", "detail", userId] as const

export interface EmployeeRolesState {
  /** Toàn bộ vai trò của công ty (chỉ có khi người xem được gán). */
  roles: RoleSummary[]
  /** Tên vai trò người này đang giữ. */
  heldNames: string[]
  /** Id vai trò đang giữ; null = chưa ánh xạ chắc chắn được (khoá gán). */
  heldIds: number[] | null
  loading: boolean
  error: unknown
}

export function useEmployeeRoles(userId: number, { canView, canAssign }: { canView: boolean; canAssign: boolean }): EmployeeRolesState {
  const user = useQuery({
    queryKey: userDetailKey(userId),
    enabled: canView,
    queryFn: async () => (await apiClient.get<UserDetail>(`/users/${userId}`)).data,
    staleTime: 30_000,
  })
  const list = useRoleList(canView && canAssign)
  const roles = React.useMemo(() => (canAssign ? (list.data ?? []) : []), [canAssign, list.data])
  const heldNames = React.useMemo(() => user.data?.roles ?? [], [user.data])
  const heldIds = React.useMemo(() => {
    if (!user.data || !list.data) return null
    const byName = new Map(list.data.map((r) => [r.name, r.id]))
    const ids: number[] = []
    for (const n of heldNames) {
      const id = byName.get(n)
      if (id === undefined) return null
      ids.push(id)
    }
    return ids
  }, [user.data, list.data, heldNames])
  return {
    roles,
    heldNames,
    heldIds,
    loading: user.isLoading || (canAssign && list.isLoading),
    error: user.error ?? (canAssign ? list.error : null),
  }
}

/** Câu «Được phép…» lấy từ mô tả vai trò thật (Cài đặt → Vai trò). */
export function permissionText(held: string[], roles: RoleSummary[]): string | null {
  if (held.length === 0) return null
  const desc = held
    .map((n) => roles.find((r) => r.name === n)?.description?.trim())
    .filter((d): d is string => Boolean(d))
    .map((d) => d.replace(/[.。]+$/, ""))
  return desc.length ? `Được phép: ${desc.join("; ")}.` : null
}

/** Chip chọn dạng viên thuốc 40px (điện thoại 44px) — chọn: viền xanh + nền xanh nhạt. */
export function ChoicePill({
  on,
  disabled,
  onClick,
  title,
  children,
  className,
}: {
  on: boolean
  disabled?: boolean
  onClick?: () => void
  title?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-10 max-w-full cursor-pointer items-center rounded-full border px-4 text-[15px] font-semibold whitespace-nowrap transition-colors duration-150 max-sm:h-11",
        "focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        on
          ? "border-ax-primary bg-ax-primary-soft text-ax-primary-press"
          : "border-ax-btn-border bg-ax-surface text-ax-ink hover:bg-ax-hover",
        className,
      )}
    >
      <span className="truncate">{children}</span>
    </button>
  )
}

export function EmployeeRolesCard({
  userId,
  name,
  canView,
  canAssign,
  isAdmin,
  variant,
}: {
  userId: number
  name: string
  canView: boolean
  canAssign: boolean
  isAdmin: boolean
  variant: "desktop" | "mobile"
}) {
  const st = useEmployeeRoles(userId, { canView, canAssign })
  const setRoles = useSetUserRoles()
  // Ngoài phạm vi `users.view` của người xem (404/403) ⇒ không có gì để hiện, ẩn hẳn khối.
  const outOfScope = isAxiosError(st.error) && [403, 404].includes(st.error.response?.status ?? 0)
  if (!canView || outOfScope) return null

  const busy = setRoles.isPending
  const ready = canAssign && st.heldIds !== null

  function apply(next: number[], prev: number[], message: string) {
    setRoles.mutate(
      { userId, roleIds: next },
      {
        onSuccess: () =>
          showUndoToast(message, {
            onUndo: () =>
              setRoles.mutate(
                { userId, roleIds: prev },
                { onError: (err) => toast.error(errorMessage(err, "Chưa hoàn tác được vai trò")) },
              ),
          }),
        onError: (err) => toast.error(errorMessage(err, "Chưa đổi được vai trò")),
      },
    )
  }

  function toggle(r: RoleSummary) {
    if (!ready || busy || st.heldIds === null) return
    const prev = st.heldIds
    const on = prev.includes(r.id)
    const next = on ? prev.filter((x) => x !== r.id) : [...prev, r.id]
    apply(next, prev, `${on ? "Đã bỏ vai trò" : "Đã thêm vai trò"} ${r.name} của ${name}`)
  }

  // Người xem chỉ được xem: hiện các vai trò đang giữ (không bấm được).
  const shown: { key: string; label: string; on: boolean; role?: RoleSummary; locked: boolean }[] = canAssign
    ? st.roles.map((r) => ({
        key: String(r.id),
        label: r.name,
        on: st.heldNames.includes(r.name),
        role: r,
        locked: !ready || busy || (r.is_system && !isAdmin),
      }))
    : st.heldNames.map((n) => ({ key: n, label: n, on: true, locked: true }))

  const perm = permissionText(st.heldNames, st.roles)
  const empty = !st.loading && !st.error && st.heldNames.length === 0

  const body = (
    <>
      {st.loading ? (
        <p className="text-sm text-ax-ink-3">Đang tải vai trò…</p>
      ) : st.error ? (
        <p className="text-sm text-ax-danger">{errorMessage(st.error, "Không tải được vai trò")}</p>
      ) : (
        <div role="group" aria-label={`Vai trò của ${name}`} className="flex flex-wrap gap-2">
          {shown.map((c) => (
            <ChoicePill
              key={c.key}
              on={c.on}
              disabled={c.locked}
              title={c.role?.is_system && !isAdmin ? "Chỉ Quản trị gán được vai trò hệ thống" : undefined}
              onClick={c.role ? () => toggle(c.role as RoleSummary) : undefined}
            >
              {c.label}
            </ChoicePill>
          ))}
        </div>
      )}
      {empty ? (
        <p className="mt-2.5 text-[13px] leading-5 text-ax-warn">
          Chưa có vai trò nào. Nhân viên đăng nhập được nhưng chưa thấy mục nào.
          {canAssign ? " Chọn ít nhất một vai trò." : ""}
        </p>
      ) : perm ? (
        <p className="mt-2.5 text-[13px] leading-5 text-ax-ink-2">{perm}</p>
      ) : null}
      {!canAssign && !st.loading && !st.error && (
        <p className="mt-1.5 text-[13px] leading-5 text-ax-ink-3">Đổi vai trò cần quyền quản lý người dùng.</p>
      )}
    </>
  )

  if (variant === "mobile") {
    return (
      <section aria-label="Vai trò" className="mt-3">
        <h2 className="mx-8 mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-ax-ink-3 uppercase">Vai trò</h2>
        <div className="mx-4 rounded-ax-card bg-ax-surface p-3 shadow-ax-card">{body}</div>
      </section>
    )
  }
  return (
    <section aria-label="Vai trò" className="rounded-ax-card border border-ax-line bg-ax-surface px-5 py-4 shadow-ax-card">
      <h3 className="text-base font-bold tracking-[-0.011em] text-ax-ink">Vai trò</h3>
      {canAssign && (
        <p className="mt-0.5 mb-3 text-[13px] leading-5 text-ax-ink-2">Chọn nhiều vai trò, quyền cộng dồn. Đổi có hiệu lực ngay.</p>
      )}
      <div className={cn(!canAssign && "mt-3")}>{body}</div>
    </section>
  )
}
