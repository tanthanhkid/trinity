/**
 * Khoá bất biến: MỌI prefix `/api/v1/*` trong `LOCAL_ROUTES` của proxy
 * `app/api/v1/[...path]/route.ts` phải trỏ tới monolith (`:4000`) — các service
 * NestJS đã gộp thành 1 process, không còn cổng rời nào lắng nghe.
 *
 * 🔴 Vì sao là test, không phải "nhớ thêm": thiếu 1 prefix KHÔNG cho ra 404 gọn
 * gàng. `getBackendUrl()` không khớp prefix nào thì trả `BACKEND_URL`; nếu đó là
 * `http://localhost` ⇒ request đi tới reverse proxy cổng 80 ⇒ không có
 * `location` cho prefix đó ⇒ rơi vào catch-all `/` ⇒ quay về CHÍNH route proxy
 * này ⇒ **LẶP**. Build xanh, test cũ xanh — chỉ người dùng thấy treo.
 *
 * Và đừng đọc tên `LOCAL_ROUTES` rồi tưởng nó chỉ dùng ở dev: điều kiện là
 * `NODE_ENV === 'development' || BACKEND_URL.includes('localhost')` — nhánh sau
 * đúng cả trên production.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROUTE_FILE = join(process.cwd(), 'src/app/api/v1/[...path]/route.ts')
const MONOLITH_PORT = 'http://localhost:4000'

function localRoutes(): Record<string, string> {
  const src = readFileSync(ROUTE_FILE, 'utf8')
  const block = src.slice(
    src.indexOf('const LOCAL_ROUTES'),
    src.indexOf('function getBackendUrl'),
  )
  const out: Record<string, string> = {}
  for (const m of block.matchAll(/'(\/api\/v1\/[^']+)':\s*'([^']+)'/g)) {
    out[m[1]] = m[2]
  }
  return out
}

describe('proxy /api/v1 — mọi prefix phải route thẳng tới monolith (:4000)', () => {
  it('products trỏ đúng monolith (:4000)', () => {
    const routes = localRoutes()
    expect(routes['/api/v1/products']).toBe(MONOLITH_PORT)
  })

  it('🔴 mọi prefix trong bảng đều trỏ ĐÚNG monolith :4000 — không còn rải theo service rời', () => {
    for (const [prefix, url] of Object.entries(localRoutes())) {
      expect(url, `${prefix} → ${url}`).toBe(MONOLITH_PORT)
      expect(prefix.startsWith('/api/v1/')).toBe(true)
    }
  })

  it('bảng được dùng ở PRODUCTION, không chỉ dev — điều kiện phải còn nhánh BACKEND_URL.includes', () => {
    const src = readFileSync(ROUTE_FILE, 'utf8')
    expect(src).toContain("BACKEND_URL.includes('localhost')")
  })
})
