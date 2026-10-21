"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { MobileActionBar } from "@/components/app-shell/mobile-action-bar"
import { Button } from "@/components/ui/button"
import {
  useLoginWifiCheckRoster,
  useLoginWifiCheckTargets,
  useReplaceLoginWifiCheckTargets,
  type LoginWifiCheckScopeType,
  type LoginWifiCheckTargetItem,
} from "@/hooks/use-login-wifi-check-targets"
import { resolveLoginWifiTargetPreview } from "@/lib/login-wifi-check-target-scope"
import { LoginWifiCheckTargetPicker, type PickerOption } from "./login-wifi-check-target-picker"
import { errorMessage } from "@/lib/error-messages"

type TargetKey = `${LoginWifiCheckScopeType}:${number}`
const keyOf = (scopeType: LoginWifiCheckScopeType, id: number): TargetKey => `${scopeType}:${id}`

/**
 * danh sách ÁP DỤNG (opt-in enforcement) cho "Đăng nhập theo
 * wifi văn phòng". Render BÊN TRONG `SettingsLoginWifiCheck` (đã gate quyền
 * `settings.integrations` ở tab Settings, xem `page.tsx`), KHÔNG phải component/tab riêng.
 *
 * ⚠️ Ngữ nghĩa: đây là danh sách người PHẢI bị kiểm tra khi công tắc ở trên
 * đang BẬT — KHÔNG PHẢI danh sách miễn. Chưa chọn ai = KHÔNG ai bị kiểm tra
 * dù công tắc đang bật (banner cảnh báo bên dưới khi rơi đúng trạng thái này).
 */
export function SettingsLoginWifiCheckTargets({ wifiCheckEnabled }: { wifiCheckEnabled: boolean }) {
  const targetsQuery = useLoginWifiCheckTargets(true)
  const rosterQuery = useLoginWifiCheckRoster(true)
  const replaceMut = useReplaceLoginWifiCheckTargets()

  const [selected, setSelected] = useState<Map<TargetKey, LoginWifiCheckTargetItem>>(new Map())
  const savedKeysRef = useRef<Set<TargetKey>>(new Set())
  const hasInitializedRef = useRef(false)

  // Nạp dữ liệu server VÀO state local ĐÚNG 1 LẦN khi query vừa có data —
  // tránh (setState trong thân render) bằng useEffect, và tránh refetch
  // nền (staleTime 30s) đè mất lựa chọn admin đang sửa dở bằng cờ 1-lần.
  useEffect(() => {
    if (hasInitializedRef.current || !targetsQuery.data) return
    hasInitializedRef.current = true
    const map = new Map<TargetKey, LoginWifiCheckTargetItem>()
    for (const t of targetsQuery.data) {
      map.set(keyOf(t.scope_type, t.target_user_id), {
        scope_type: t.scope_type,
        target_user_id: t.target_user_id,
      })
    }
    savedKeysRef.current = new Set(map.keys())
    setSelected(map)
  }, [targetsQuery.data])

  const toggle = (scopeType: LoginWifiCheckScopeType, id: number) => {
    setSelected((prev) => {
      const next = new Map(prev)
      const key = keyOf(scopeType, id)
      if (next.has(key)) next.delete(key)
      else next.set(key, { scope_type: scopeType, target_user_id: id })
      return next
    })
  }

  const roster = rosterQuery.data ?? []
  // "Phòng"/"Team" định nghĩa THUẦN CẤU TRÚC theo cây `manager_id` (mirror BE
  // `assertValidTargets`): Team = quản lý ≥1 người; Phòng = có ≥1 cấp dưới mà
  // cấp dưới đó cũng đang quản lý người khác.
  const { departmentOptions, teamOptions } = useMemo(() => {
    const managers = new Set<number>()
    for (const u of roster) if (u.manager_id != null) managers.add(u.manager_id)
    const toOption = (u: (typeof roster)[number]): PickerOption => ({
      id: u.id,
      label: u.full_name || u.email,
      sublabel: u.email,
    })
    const team = roster.filter((u) => managers.has(u.id))
    const department = team.filter((u) =>
      roster.some((r) => r.manager_id === u.id && managers.has(r.id)),
    )
    return { departmentOptions: department.map(toOption), teamOptions: team.map(toOption) }
  }, [roster])
  const userOptions = useMemo<PickerOption[]>(
    () =>
      roster.map((u) => ({
        id: u.id,
        label: u.full_name || u.email,
        sublabel: u.roles.length > 0 ? `${u.roles.join(", ")} · ${u.email}` : u.email,
      })),
    [roster],
  )

  const selectedByType = (scopeType: LoginWifiCheckScopeType) =>
    new Set(
      Array.from(selected.values())
        .filter((s) => s.scope_type === scopeType)
        .map((s) => s.target_user_id),
    )

  const previewCount = useMemo(
    () => resolveLoginWifiTargetPreview(roster, Array.from(selected.values())).size,
    [roster, selected],
  )

  const currentKeys = new Set(selected.keys())
  const isDirty =
    currentKeys.size !== savedKeysRef.current.size ||
    Array.from(currentKeys).some((k) => !savedKeysRef.current.has(k))

  const handleSave = () => {
    replaceMut.mutate(Array.from(selected.values()), {
      onSuccess: () => {
        savedKeysRef.current = new Set(selected.keys())
        toast.success("Đã lưu danh sách áp dụng kiểm tra wifi")
      },
      onError: (err) => toast.error(errorMessage(err, "Không lưu được, vui lòng thử lại")),
    })
  }

  if (targetsQuery.isLoading || rosterQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Đang tải danh sách áp dụng...
      </div>
    )
  }

  return (
    <div className="space-y-4 border-t pt-4">
      <div>
        <p className="text-sm font-semibold">Danh sách áp dụng kiểm tra wifi</p>
        <p className="text-xs text-muted-foreground">
          Chỉ nhân viên được chọn dưới đây (theo Phòng/Team/Nhân viên) mới bị kiểm tra IP khi
          công tắc ở trên đang BẬT. KHÔNG chọn ai = không ai bị kiểm tra, kể cả khi công tắc BẬT —
          dùng cho nhân viên hay đi công tác ngoài văn phòng.
        </p>
      </div>

      {wifiCheckEnabled && selected.size === 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            Công tắc đang BẬT nhưng CHƯA chọn ai ở dưới — hiện KHÔNG ai bị kiểm tra IP khi đăng
            nhập. Chọn Phòng/Team/Nhân viên bên dưới rồi bấm Lưu để bắt đầu áp dụng.
          </span>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <LoginWifiCheckTargetPicker
          title="Theo Phòng (quản lý nhiều cấp)"
          options={departmentOptions}
          selectedIds={selectedByType("department")}
          onToggle={(id) => toggle("department", id)}
          emptyLabel="Chưa có quản lý cấp Phòng nào"
        />
        <LoginWifiCheckTargetPicker
          title="Theo Team (người quản lý trực tiếp)"
          options={teamOptions}
          selectedIds={selectedByType("team")}
          onToggle={(id) => toggle("team", id)}
          emptyLabel="Chưa có người quản lý nào"
        />
        <LoginWifiCheckTargetPicker
          title="Theo nhân viên"
          options={userOptions}
          selectedIds={selectedByType("user")}
          onToggle={(id) => toggle("user", id)}
          searchable
          emptyLabel="Chưa có nhân viên nào"
        />
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Ước tính sẽ áp dụng cho khoảng <span className="font-semibold">{previewCount}</span>{" "}
          nhân viên (tính cả Team/Phòng đã chọn kéo theo cấp dưới).
        </p>
        <Button size="sm" className="max-sm:hidden" disabled={!isDirty || replaceMut.isPending} onClick={handleSave}>
          {replaceMut.isPending ? (
            <Loader2 className="mr-1.5 size-4 animate-spin" />
          ) : null}
          Lưu danh sách
        </Button>
      </div>
      {isDirty && (
        <MobileActionBar className="sm:hidden">
          <Button disabled={replaceMut.isPending} onClick={handleSave}>
            {replaceMut.isPending ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : null}
            Lưu danh sách
          </Button>
        </MobileActionBar>
      )}
    </div>
  )
}
