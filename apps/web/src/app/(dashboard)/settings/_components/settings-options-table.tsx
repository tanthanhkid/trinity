'use client'

import { SettingsSectionActions } from './settings-section-header'
import { useMemo, useState } from 'react'
import { MOBILE_FAB_CLASS } from '@/components/app-shell/mobile-primary'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Plus, Search } from 'lucide-react'
import {
  SettingOption,
  useSettingsOptions,
} from '@/hooks/use-settings-options'
import {
  OptionDialogState,
  SettingsOptionDialog,
} from './settings-option-dialog'
import { SettingsOptionRow } from './settings-option-row'
import { SettingsOptionCard } from './settings-option-card'
import { ShellResponsiveList } from '@/components/app-shell/responsive-list'
import { useOptionsHandlers } from './use-options-handlers'

export interface SettingsOptionsTableProps {
  group: string
  title: string
  description: string
  valueHint?: string
  /** Render cột thêm sau cột sort_order (vd: retry policy). */
  renderExtraColumns?: {
    headers: string[]
    renderCells: (option: SettingOption) => React.ReactNode
    /** Nội dung cột thêm dạng thẻ (điện thoại). Thiếu → không hiện. */
    renderCard?: (option: SettingOption) => React.ReactNode
  }
}

const EMPTY_DIALOG: OptionDialogState = {
  mode: 'create',
  label: '',
  value: '',
  sort_order: 0,
}

export function SettingsOptionsTable({
  group,
  title,
  description,
  valueHint,
  renderExtraColumns,
}: SettingsOptionsTableProps) {
  const { data = [], isLoading } = useSettingsOptions(group, { activeOnly: false })
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<OptionDialogState | null>(null)
  const [toHide, setToHide] = useState<SettingOption | null>(null)
  const { handleSubmit, toggleActive, handleDelete, saving } =
    useOptionsHandlers({ group, dialog, onClose: () => setDialog(null) })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return data
    return data.filter(
      (o) =>
        o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    )
  }, [data, search])

  const extraHeaderCount = renderExtraColumns?.headers.length ?? 0
  const totalCols = 7 + extraHeaderCount

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="max-sm:line-clamp-2">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="relative w-full max-w-xs max-sm:max-w-none">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Tìm theo nhãn hoặc mã..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 max-sm:h-11"
            />
          </div>
          <SettingsSectionActions>
            <Button className={MOBILE_FAB_CLASS} onClick={() => setDialog({ ...EMPTY_DIALOG })}>
              <Plus className="size-4" />
              Thêm mục
            </Button>
          </SettingsSectionActions>
        </div>

        <ShellResponsiveList
          table={
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nhãn hiển thị</TableHead>
                <TableHead>Mã</TableHead>
                <TableHead className="w-24">Thứ tự</TableHead>
                {renderExtraColumns?.headers.map((h) => (
                  <TableHead key={h}>{h}</TableHead>
                ))}
                <TableHead className="w-24">Đang bật</TableHead>
                <TableHead className="w-20">Hệ thống</TableHead>
                <TableHead className="w-32 text-right">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={totalCols} className="text-center text-muted-foreground">
                    Đang tải...
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={totalCols} className="text-center text-muted-foreground">
                    Không có dữ liệu
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((opt) => (
                  <SettingsOptionRow
                    key={opt.id}
                    option={opt}
                    renderExtraCells={renderExtraColumns?.renderCells}
                    onEdit={setDialog}
                    onToggleActive={toggleActive}
                    onDelete={setToHide}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
          }
          cards={
            <div className="space-y-3">
              {isLoading ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Đang tải...</p>
              ) : filtered.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Không có dữ liệu</p>
              ) : (
                filtered.map((opt) => (
                  <SettingsOptionCard
                    key={opt.id}
                    option={opt}
                    renderExtra={renderExtraColumns?.renderCard}
                    onEdit={setDialog}
                    onToggleActive={toggleActive}
                    onDelete={setToHide}
                  />
                ))
              )}
            </div>
          }
        />
      </CardContent>

      <ConfirmDialog
        open={toHide !== null}
        onOpenChange={(o) => !o && setToHide(null)}
        title="Ẩn giá trị"
        description={`Ẩn giá trị "${toHide?.label ?? ''}" khỏi danh sách?`}
        confirmLabel="Ẩn giá trị"
        pending={saving}
        onConfirm={async () => {
          if (toHide) await handleDelete(toHide)
          setToHide(null)
        }}
      />

      <SettingsOptionDialog
        state={dialog}
        valueHint={valueHint}
        saving={saving}
        onClose={() => setDialog(null)}
        onChange={(update) => setDialog((prev) => update(prev))}
        onSubmit={handleSubmit}
      />
    </Card>
  )
}
