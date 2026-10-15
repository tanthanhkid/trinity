"use client"

/**
 * POS bán hàng tại quầy — route `/pos` (`/api/v1/pos/*`). Menu chỉ hiện cho người có quyền `pos.sell`.
 */
import { PermissionGate } from "@/lib/rbac"
import { PosScreen } from "./_components/pos-screen"

export default function PosPage() {
  return (
    <PermissionGate permission="pos.sell">
      <PosScreen />
    </PermissionGate>
  )
}
