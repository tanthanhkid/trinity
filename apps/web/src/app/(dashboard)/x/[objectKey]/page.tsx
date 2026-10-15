"use client"

/**
 * Danh sách bản ghi của 1 "tính năng tuỳ biến" — route NẰM TRONG `(dashboard)` (một
 * layout, một cây provider). Khoá `objectKey` do người dùng đặt; BE trả 404 nếu không tồn tại/không được thấy.
 */
import { useParams } from "next/navigation"
import { PermissionGate } from "@/lib/rbac"
import { CustomObjectGate } from "@/components/custom-objects/custom-object-gate"
import { CustomRecordsScreen } from "@/components/custom-objects/custom-records-screen"

export default function CustomObjectListPage() {
  const { objectKey } = useParams<{ objectKey: string }>()
  return (
    <PermissionGate permission="custom_records.view">
      <CustomObjectGate objectKey={objectKey}>{(def) => <CustomRecordsScreen def={def} />}</CustomObjectGate>
    </PermissionGate>
  )
}
