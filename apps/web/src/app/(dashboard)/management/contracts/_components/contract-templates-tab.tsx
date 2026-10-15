"use client"

import { useRef, useState, type ChangeEvent } from "react"
import { Download, FileText, Loader2, MoreHorizontal, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { cn } from "@/lib/utils"
import { formatDate } from "@/lib/format"
import {
  useContractTemplates,
  useUploadContractTemplate,
  useDeleteContractTemplate,
  useDownloadContractTemplate,
  type ContractTemplate,
} from "@/hooks/use-contracts"

const MAX_BYTES = 20 * 1024 * 1024
const ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx"

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

export function ContractTemplatesTab({ canWrite }: { canWrite: boolean }) {
  const { data: templates, isLoading } = useContractTemplates()
  const upload = useUploadContractTemplate()
  const del = useDeleteContractTemplate()
  const download = useDownloadContractTemplate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = "" // reset để chọn lại cùng file vẫn fire onChange
    if (!file) return
    if (file.size > MAX_BYTES) {
      toast.error("File quá lớn (tối đa 20MB).")
      return
    }
    upload.mutate(
      { file },
      {
        onSuccess: () => toast.success("Đã tải lên hồ sơ mẫu."),
        onError: () =>
          toast.error(
            "Không tải lên được — kiểm tra định dạng (PDF/Word/Excel) hoặc quyền.",
          ),
      },
    )
  }

  function onDelete(id: number) {
    del.mutate(id, {
      onSuccess: () => {
        toast.success("Đã xoá hồ sơ mẫu.")
        setConfirmId(null)
      },
      onError: () => toast.error("Không xoá được hồ sơ mẫu."),
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          File mẫu chung (quy chế lương, phụ lục HĐLĐ, hợp đồng mẫu…) cho nhân viên tải
          xuống.
        </p>
        {canWrite && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              hidden
              onChange={onPickFile}
            />
            <Button
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={upload.isPending}
              className={cn("gap-2", MOBILE_FAB_CLASS)}
            >
              {upload.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              Tải lên file mẫu
            </Button>
          </>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Đang tải…</p>
      ) : !templates || templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
            <FileText className="size-8 opacity-50" />
            <p className="text-sm">Chưa có hồ sơ mẫu nào.</p>
            {canWrite && <p className="text-xs">Bấm “Tải lên file mẫu” để thêm.</p>}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {templates.map((t: ContractTemplate) => (
            <Card key={t.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <FileText className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatBytes(t.size)} · {formatDate(t.created_at)}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={() => download.mutate({ id: t.id, name: t.name })}
                  >
                    <Download className="size-4" /> Tải về
                  </Button>
                  {canWrite && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive max-sm:hidden"
                        aria-label="Xoá hồ sơ mẫu"
                        onClick={() => setConfirmId(t.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Thao tác khác"
                              className="sm:hidden"
                            />
                          }
                        >
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setConfirmId(t.id)}
                          >
                            <Trash2 className="size-4" /> Xoá
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={confirmId !== null}
        onOpenChange={(o) => !o && setConfirmId(null)}
        title="Xoá hồ sơ mẫu"
        description="Xoá hồ sơ mẫu này? Thao tác không hoàn tác được."
        confirmLabel="Xoá hồ sơ mẫu"
        pending={del.isPending}
        onConfirm={() => {
          if (confirmId !== null) onDelete(confirmId)
        }}
      />
    </div>
  )
}
