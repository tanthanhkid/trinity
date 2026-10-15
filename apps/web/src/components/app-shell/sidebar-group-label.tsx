/**
 * Tiêu đề nhóm menu (demo giao diện mới `.nav-h`): 14px, chữ thường, màu
 * `--color-app-sidebar-muted` (= --ink-3, ≥4,5:1 trên --sidebar và --card — khoá ở
 * `__tests__/app-shell/contrast.test.ts`). Plain `<div>` — KHÔNG phải primitive
 * `@/components/ui/sidebar` nên không kéo theo rủi ro thiếu mock ở test render.
 */
export function ShellGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-3 pb-1 text-sm text-[color:var(--color-app-sidebar-muted)] group-data-[collapsible=icon]:hidden">
      {children}
    </div>
  )
}
