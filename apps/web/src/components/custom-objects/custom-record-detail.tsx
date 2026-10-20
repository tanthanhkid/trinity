"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, Loader2, SearchX, Trash2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { ShellEmptyState } from "@/components/app-shell/empty-state"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { useCustomRecord, useCustomRecordMutations, useCustomRelated } from "@/hooks/custom-objects/use-custom-objects"
import { getApiErrorMessage } from "@/lib/api-client"
import { customIcon } from "@/lib/custom-objects/icons"
import { formatDateTimeVn } from "@/lib/format"
import { usePermissions } from "@/lib/rbac"
import type { CustomObjectDef } from "@/types/custom-objects"
import { CustomRecordForm } from "./custom-record-form"
import { RecordCode } from "./record-code"
import { MentionedIn } from "@/components/refs/mentioned-in"
import { LoadingBlock } from "@/components/ui/loading-block"

function RelatedGroups({ objectKey, id }: { objectKey: string; id: number }) {
  const q = useCustomRelated(objectKey, id)
  const groups = q.data ?? []
  if (groups.length === 0) return null
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <Card key={`${g.object.key}.${g.field.key}`} className="rounded-2xl">
          <CardContent className="space-y-2 p-4">
            <p className="text-sm font-semibold">{g.object.label_plural} <span className="font-normal text-muted-foreground">(theo “{g.field.label}”) · {g.total}</span></p>
            <ul className="flex flex-wrap gap-2">
              {g.items.map((it) => (
                <li key={it.id}>
                  <Link href={`/x/${g.object.key}/${it.id}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1 text-sm text-primary hover:bg-muted"><RecordCode code={it.code} />{it.title}</Link>
                </li>
              ))}
              {g.total > g.items.length && <li className="self-center text-sm text-muted-foreground">và {g.total - g.items.length} mục khác — xem ở danh sách {g.object.label_plural} (lọc theo “{g.field.label}”)</li>}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

/** Xem + sửa 1 bản ghi (sửa khi có `custom_records.manage`), bản ghi liên quan ngược, xoá khi có `custom_records.delete`. */
export function CustomRecordDetail({ def, id }: { def: CustomObjectDef; id: number }) {
  const router = useRouter()
  const { can } = usePermissions()
  const q = useCustomRecord(def.key, id)
  const { remove } = useCustomRecordMutations(def.key)
  const [confirm, setConfirm] = useState(false)
  const Icon = customIcon(def.icon)
  const back = (
    <Link href={`/x/${def.key}`} className={buttonVariants({ variant: "ghost" }) + " max-sm:min-h-11"}><ArrowLeft className="mr-1.5 size-4" /> {def.label_plural}</Link>
  )

  if (q.isLoading) return <LoadingBlock className="mx-auto max-w-3xl p-6" count={4} avatar />
  if (q.isError && (q.error as { response?: { status?: number } })?.response?.status !== 404) {
    return <ShellEmptyState icon={TriangleAlert} title="Không tải được bản ghi" description={getApiErrorMessage(q.error, "Vui lòng thử lại sau")} action={<Button variant="outline" onClick={() => void q.refetch()}>Thử lại</Button>} />
  }
  if (q.isError || !q.data) {
    return <ShellEmptyState icon={SearchX} title="Không tìm thấy bản ghi" description="Bản ghi không tồn tại hoặc nằm ngoài phạm vi của bạn." action={back} />
  }
  const rec = q.data

  return (
    <div className="space-y-4">
      <ShellPageHeader
        icon={Icon}
        title={rec.code ? `${rec.code} · ${rec.title}` : rec.title}
        description={`${def.label} · Phụ trách: ${rec.owner_name ?? "—"} · Cập nhật ${formatDateTimeVn(rec.updated_at)}`}
        actions={back}
      />
      <CustomRecordForm key={rec.id} def={def} record={rec} readOnly={!can("custom_records.manage")} />
      <RelatedGroups objectKey={def.key} id={rec.id} />
      <MentionedIn type="record" id={rec.id} />
      {can("custom_records.delete") && (
        <div className="flex justify-start border-t pt-4">
          <Button type="button" variant="outline" className="text-destructive" onClick={() => setConfirm(true)}>
            <Trash2 className="mr-1.5 size-4" /> Xoá {def.label.toLowerCase()}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Xoá ${def.label.toLowerCase()} “${rec.title}”?`}
        description="Bản ghi sẽ bị ẩn khỏi danh sách. Các bản ghi đang liên kết tới nó sẽ hiện “Không xem được”."
        confirmLabel={`Xoá ${def.label.toLowerCase()}`}
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(rec.id, {
            onSuccess: () => { setConfirm(false); toast.success("Đã xoá"); router.push(`/x/${def.key}`) },
            onError: (e) => toast.error(getApiErrorMessage(e, "Không xoá được, vui lòng thử lại")),
          })
        }
      />
    </div>
  )
}
