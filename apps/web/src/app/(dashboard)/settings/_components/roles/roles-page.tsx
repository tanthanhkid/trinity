'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ArrowLeft, Copy, MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useIsPhone } from '@/hooks/use-is-phone'
import { cn } from '@/lib/utils'
import { SettingsSectionActions } from '../settings-section-header'
import { RoleEditor } from './role-editor'
import { RoleList } from './role-list'
import {
  apiErrorMessage,
  useCloneRole,
  useCreateRole,
  useDeleteRole,
  useRoleDetail,
  useRoleList,
  type RoleSummary,
} from './use-roles-api'

/** Mở chi tiết trên điện thoại: về đầu trang (vùng cuộn là `<main>` hoặc window). */
function scrollToTop() {
  window.scrollTo(0, 0)
  document.querySelector('main')?.scrollTo(0, 0)
}

/** Cài đặt > Vai trò: 2 cột (danh sách | chi tiết Quyền / Người giữ / Nhật ký). */
export function RolesPage() {
  const { data: roles = [], isLoading } = useRoleList()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // Điện thoại: danh sách → chi tiết toàn màn. Chỉ tác dụng <640px (CSS `max-sm:`);
  // ≥640px luôn hiện cả hai như cũ.
  const [phoneDetail, setPhoneDetail] = useState(false)
  const isPhone = useIsPhone()
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [toDelete, setToDelete] = useState<RoleSummary | null>(null)
  const create = useCreateRole()
  const clone = useCloneRole()
  const remove = useDeleteRole()

  // Mặc định chọn vai trò đầu tiên (derive, không setState trong render).
  const activeId = selectedId ?? roles[0]?.id ?? null
  const { data: detail, isLoading: detailLoading } = useRoleDetail(activeId)

  function submitCreate() {
    const name = newName.trim()
    if (name.length < 2) return
    create.mutate(
      { name, grants: {} },
      {
        onSuccess: (r) => {
          toast.success('Đã tạo vai trò — tick quyền rồi bấm Lưu')
          setSelectedId(r.id)
          setPhoneDetail(true)
          setShowCreate(false)
          setNewName('')
        },
        onError: (e) => toast.error(apiErrorMessage(e, 'Không tạo được vai trò')),
      },
    )
  }

  function doClone(r: RoleSummary) {
    clone.mutate(r.id, {
      onSuccess: (c) => {
        toast.success('Đã nhân bản vai trò')
        setSelectedId(c.id)
        setPhoneDetail(true)
      },
      onError: (e) => toast.error(apiErrorMessage(e, 'Không nhân bản được')),
    })
  }

  function doDelete() {
    if (!toDelete) return
    remove.mutate(toDelete.id, {
      onSuccess: () => {
        toast.success('Đã xoá vai trò')
        if (selectedId === toDelete.id) setSelectedId(null)
        setPhoneDetail(false)
        setToDelete(null)
      },
      onError: (e) => {
        toast.error(apiErrorMessage(e, 'Không xoá được vai trò'))
        setToDelete(null)
      },
    })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      {/* FAB chỉ ở view danh sách; view chi tiết dùng thanh đáy của RoleEditor (không dùng chung một màn). */}
      {!(isPhone && phoneDetail) && (
        <SettingsSectionActions mobile="fab">
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="mr-2 h-4 w-4" /> Tạo vai trò
          </Button>
        </SettingsSectionActions>
      )}
      {/* sm:contents — ≥640px hai wrapper này biến mất, RoleList/RoleEditor là con trực tiếp của grid như cũ. */}
      <div className={cn('sm:contents', phoneDetail && 'max-sm:hidden')}>
        <RoleList
          roles={roles}
          selectedId={activeId}
          isLoading={isLoading}
          onSelect={(id) => {
            setSelectedId(id)
            setPhoneDetail(true)
            scrollToTop()
          }}
          onClone={doClone}
          onDelete={setToDelete}
        />
      </div>
      <div className={cn('flex min-w-0 flex-col gap-3 sm:contents', !phoneDetail && 'max-sm:hidden')}>
        <div className="flex items-center justify-between gap-2 sm:hidden">
          <Button type="button" variant="ghost" className="-ml-2" onClick={() => setPhoneDetail(false)}>
            <ArrowLeft className="h-4 w-4" /> Danh sách vai trò
          </Button>
          {detail && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button type="button" variant="ghost" size="icon" aria-label="Thao tác khác" />}
              >
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem className="max-sm:min-h-11" onClick={() => doClone(detail)}>
                  <Copy className="h-4 w-4" /> Nhân bản
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  className="max-sm:min-h-11"
                  disabled={detail.is_system}
                  onClick={() => setToDelete(detail)}
                >
                  <Trash2 className="h-4 w-4" /> Xoá vai trò
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {detail ? (
          <RoleEditor key={detail.id} role={detail} />
        ) : (
          <div className="rounded-[var(--radius)] border bg-white p-8 text-center text-sm text-muted-foreground">
            {detailLoading ? 'Đang tải...' : 'Chọn một vai trò để xem chi tiết'}
          </div>
        )}
      </div>

      <Dialog open={showCreate} onOpenChange={(o) => !o && setShowCreate(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Tạo vai trò</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="new-role-name">
              Tên vai trò
            </label>
            <Input
              id="new-role-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Ví dụ: Kế toán, Trưởng nhóm Sale"
              className="h-11"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-11" onClick={() => setShowCreate(false)}>
              Huỷ
            </Button>
            <Button className="h-11" disabled={create.isPending || newName.trim().length < 2} onClick={submitCreate}>
              {create.isPending ? 'Đang tạo...' : 'Tạo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Xoá vai trò"
        description={
          <>
            Xoá vai trò <span className="font-semibold">{toDelete?.name}</span>? Chỉ xoá được khi không còn ai giữ.
          </>
        }
        confirmLabel="Xoá vai trò"
        pending={remove.isPending}
        onConfirm={doDelete}
      />
    </div>
  )
}
