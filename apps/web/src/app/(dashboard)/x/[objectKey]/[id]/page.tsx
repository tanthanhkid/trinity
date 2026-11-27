"use client"

import { useRouteParams } from "@/lib/route-params"
import { CustomObjectGate } from "@/components/custom-objects/custom-object-gate"
import { CustomRecordDetail } from "@/components/custom-objects/custom-record-detail"
import { PermissionGate } from "@/lib/rbac"

/** Chi tiết / sửa 1 bản ghi (sửa khi có `custom_records.manage`). */
export default function CustomObjectRecordPage() {
  const route = useRouteParams<"objectKey" | "id">("/x/:objectKey/:id")
  if (!route) return null
  const { objectKey, id } = route
  const recordId = Number(id)
  return (
    <PermissionGate permission="custom_records.view">
      <CustomObjectGate objectKey={objectKey}>
        {(def) => (Number.isSafeInteger(recordId) && recordId > 0 ? <CustomRecordDetail def={def} id={recordId} /> : null)}
      </CustomObjectGate>
    </PermissionGate>
  )
}
