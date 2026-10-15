import { describe, it, expect } from 'vitest'
import {
  isHrefActive,
  resolveActiveHref,
  isItemActive,
  collectMenuHrefs,
} from '@/components/app-shell/nav-active'
import { menuItems } from '@/components/nav-config'
import { withExtraMenuItems } from '@/components/app-shell/menu-extra'

/**
 * Khoá bất biến: sidebar v2 chỉ được sáng ĐÚNG MỘT mục.
 *
 * Bug gốc: một route sáng đồng thời mục cha (`/management`, khớp tiền tố) và mục con
 * (`/management/employees`, khớp chính xác) — mỗi mục tự xét `startsWith` độc lập
 * nên cả hai đều "đúng".
 */
describe('v2 sidebar — chỉ một mục sáng', () => {
  it('khớp dài nhất thắng: /management/employees chỉ sáng mục con', () => {
    const hrefs = ['/dashboard', '/management', '/management/employees', '/management/contracts']
    const active = resolveActiveHref('/management/employees', hrefs)
    expect(active).toBe('/management/employees')
    // mục cha PHẢI tắt
    expect(isItemActive(active, '/management')).toBe(false)
    expect(isItemActive(active, '/management/employees')).toBe(true)
  })

  it('route con KHÔNG có mục menu riêng thì sáng mục cha gần nhất', () => {
    const hrefs = ['/settings', '/reports']
    const active = resolveActiveHref('/settings/some-subpage', hrefs)
    expect(active).toBe('/settings')
  })

  it('mục cha vẫn sáng khi ở đúng path của nó', () => {
    const hrefs = ['/management', '/management/employees']
    expect(resolveActiveHref('/management', hrefs)).toBe('/management')
  })

  it('không khớp gì → null, và mọi mục đều tắt', () => {
    const active = resolveActiveHref('/khong-ton-tai', ['/management', '/dashboard'])
    expect(active).toBeNull()
    expect(isItemActive(active, '/management')).toBe(false)
  })

  it('KHÔNG khớp nhầm tiền tố cắt giữa tên route (/orders vs /orders-archive)', () => {
    expect(isHrefActive('/orders-archive', '/orders')).toBe(false)
    const active = resolveActiveHref('/orders-archive', ['/orders', '/orders-archive'])
    expect(active).toBe('/orders-archive')
  })

  it('href "/" không được khớp mọi thứ', () => {
    expect(isHrefActive('/management', '/')).toBe(false)
  })

  /**
   * Test QUÉT TOÀN MENU THẬT — bắt được cặp cha/con mới mọc thêm về sau, chứ
   * không chỉ cặp đã biết. Đây là thứ vòng review trước bỏ sót.
   */
  it('với MỌI href của menu thật, không pathname nào làm 2 mục cùng sáng', () => {
    // PHẢI đi qua ĐÚNG chuỗi biến đổi của sidebar thật (`sidebar.tsx`):
    // `withExtraMenuItems(...)`.
    const items = withExtraMenuItems(menuItems)
    const hrefs = collectMenuHrefs(items, (item) => item.children ?? [])
    expect(hrefs.length).toBeGreaterThan(10)

    for (const path of hrefs) {
      const active = resolveActiveHref(path, hrefs)
      expect(active, `pathname ${path} phải có mục sáng`).not.toBeNull()
      const lit = hrefs.filter((h) => isItemActive(active, h))
      // Một href có thể xuất hiện 2 dạng (v1 + v2) nhưng `collectMenuHrefs`
      // trả Set nên mỗi chuỗi chỉ 1 lần ⇒ đúng 1 phần tử khớp bằng.
      expect(lit, `pathname ${path} làm sáng: ${lit.join(' + ')}`).toHaveLength(1)
    }
  })

  it('collectMenuHrefs trả href của mục leaf', () => {
    const hrefs = collectMenuHrefs(
      [{ key: 'k', title: 'T', icon: (() => null) as never, href: '/dashboard', iconColor: 'text-slate-600' }],
      () => [],
    )
    expect(hrefs).toContain('/dashboard')
  })
})
