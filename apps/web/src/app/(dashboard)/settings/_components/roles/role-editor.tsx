'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Save } from 'lucide-react'
import type { Grants } from '@trinity/rbac'
import { Button } from '@/components/ui/button'
import { MobileActionBar } from '@/components/app-shell/mobile-action-bar'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePermissions } from '@/lib/rbac'
import { PermissionMatrix } from './permission-matrix'
import { RoleMembers } from './role-members'
import { RoleAudit } from './role-audit'
import {
  apiErrorMessage,
  useRbacCatalog,
  useSaveGrants,
  useUpdateRole,
  type RoleDetail,
} from './use-roles-api'

function sameGrants(a: Grants, b: Grants): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => a[k as keyof Grants] === b[k as keyof Grants])
}

interface Props {
  role: RoleDetail
}

/** Cột phải: tên/mô tả + 3 tab Quyền / Người giữ / Nhật ký. Render lại bằng `key={role.id}`. */
export function RoleEditor({ role }: Props) {
  const { data: catalog } = useRbacCatalog()
  const { isAdmin, grants: myGrants } = usePermissions()
  const [draft, setDraft] = useState<Grants>(role.grants)
  const [name, setName] = useState(role.name)
  const [description, setDescription] = useState(role.description ?? '')
  const saveGrants = useSaveGrants(role.id)
  const update = useUpdateRole(role.id)

  // Guardrail: người không phải Quản trị chỉ cấp được quyền mình có.
  const disabledKeys = useMemo(() => {
    if (isAdmin || !catalog) return undefined
    return new Set(catalog.permissions.filter((p) => myGrants[p.key] === undefined).map((p) => p.key as string))
  }, [isAdmin, catalog, myGrants])

  const grantsDirty = !sameGrants(draft, role.grants)
  const metaDirty = name.trim() !== role.name || description.trim() !== (role.description ?? '')

  const pending = update.isPending || saveGrants.isPending

  function undoAll() {
    setDraft(role.grants)
    setName(role.name)
    setDescription(role.description ?? '')
  }

  /** Một nút "Lưu thay đổi": lưu tên/mô tả và quyền (phần nào đã sửa). */
  function saveChanges() {
    if (metaDirty) {
      update.mutate(
        { name: name.trim(), description: description.trim() || null },
        {
          onSuccess: () => toast.success('Đã lưu thông tin vai trò'),
          onError: (e) => toast.error(apiErrorMessage(e, 'Không lưu được vai trò')),
        },
      )
    }
    if (grantsDirty) {
      saveGrants.mutate(draft, {
        onSuccess: () => toast.success('Đã lưu quyền — áp dụng ngay, người dùng không cần đăng nhập lại'),
        onError: (e) => toast.error(apiErrorMessage(e, 'Không lưu được quyền')),
      })
    }
  }

  return (
    <section className="min-w-0 space-y-4 rounded-[var(--radius)] border bg-white p-4 shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="role-name">
            Tên vai trò
          </label>
          <Input
            id="role-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={role.is_system}
            className="h-10 max-sm:h-11"
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="role-desc">
            Mô tả
          </label>
          <Input
            id="role-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={role.is_system}
            className="h-10 max-sm:h-11"
            placeholder="Vai trò này dùng cho ai?"
          />
        </div>
      </div>
      <Tabs defaultValue="perms">
        <TabsList>
          <TabsTrigger value="perms">Quyền</TabsTrigger>
          <TabsTrigger value="members">Người giữ ({role.member_count})</TabsTrigger>
          <TabsTrigger value="audit">Nhật ký</TabsTrigger>
        </TabsList>
        <TabsContent value="perms" className="space-y-3 pt-3">
          {role.is_system && (
            <p className="rounded-lg bg-purple-50 px-3 py-2 text-sm text-purple-800">
              Vai trò hệ thống — Toàn quyền, phạm vi toàn công ty. Không sửa hoặc xoá được.
            </p>
          )}
          {catalog ? (
            <PermissionMatrix
              catalog={catalog}
              value={draft}
              onChange={setDraft}
              readOnly={role.is_system}
              disabledKeys={disabledKeys}
            />
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">Đang tải danh mục quyền...</p>
          )}
        </TabsContent>
        <TabsContent value="members" className="pt-3">
          <RoleMembers role={role} />
        </TabsContent>
        <TabsContent value="audit" className="pt-3">
          <RoleAudit roleId={role.id} catalog={catalog} />
        </TabsContent>
      </Tabs>

      {!role.is_system && (
        // Desktop giữ thanh sticky trong card như cũ; <640px = thanh dính đáy màn.
        <MobileActionBar className="sm:sticky sm:bottom-0 sm:items-center sm:border-t sm:bg-white sm:py-3">
          {(grantsDirty || metaDirty) && (
            <Button variant="outline" className="max-sm:border-transparent max-sm:bg-transparent" onClick={undoAll}>
              Hoàn tác
            </Button>
          )}
          <Button
            variant="outline"
            disabled={!(grantsDirty || metaDirty) || pending || name.trim().length < 2}
            onClick={saveChanges}
          >
            <Save className="mr-2 h-4 w-4" />
            {pending ? 'Đang lưu...' : 'Lưu thay đổi'}
          </Button>
        </MobileActionBar>
      )}
    </section>
  )
}
