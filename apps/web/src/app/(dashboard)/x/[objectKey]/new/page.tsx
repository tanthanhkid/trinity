"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { CustomObjectGate } from "@/components/custom-objects/custom-object-gate"
import { CustomRecordForm } from "@/components/custom-objects/custom-record-form"
import { customIcon } from "@/lib/custom-objects/icons"
import { PermissionGate } from "@/lib/rbac"

/** Thêm bản ghi mới — cần `custom_records.manage` (BE kiểm lại, cùng `custom_records.view`). */
export default function CustomObjectNewPage() {
  const { objectKey } = useParams<{ objectKey: string }>()
  return (
    <PermissionGate permission="custom_records.manage">
      <CustomObjectGate objectKey={objectKey}>
        {(def) => (
          <div className="space-y-4">
            <ShellPageHeader
              icon={customIcon(def.icon)}
              title={`Thêm ${def.label.toLowerCase()}`}
              actions={<Link href={`/x/${def.key}`} className={buttonVariants({ variant: "ghost" }) + " max-sm:min-h-11"}><ArrowLeft className="mr-1.5 size-4" /> {def.label_plural}</Link>}
            />
            <CustomRecordForm def={def} />
          </div>
        )}
      </CustomObjectGate>
    </PermissionGate>
  )
}
