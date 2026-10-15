import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Mock Next.js router
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

// `next/font/google` KHÔNG phải module thường: nó là macro do SWC/webpack của
// Next biến đổi lúc build, nên import trực tiếp dưới vitest cho ra object không
// có hàm nào ⇒ `Be_Vietnam_Pro is not a function`. Trước đây chưa cần
// mock vì 2 chỗ dùng font (`app/layout.tsx`, `lib/app-font.ts`) không nằm trong
// cây import của bất kỳ test nào; sau khi `app-font` được đưa vào `login/page.tsx`,
// `login.test.tsx` bắt đầu vỡ.
//
// ⚠️ Khai TƯỜNG MINH từng font, đừng dùng Proxy "bắt mọi tên". Đã thử và vỡ 2
// lần: (1) Proxy trả hàm cho MỌI thuộc tính nên `.then` thành function ⇒ module
// namespace bị coi là **thenable** ⇒ `await import()` treo, cả 5 test hết
// timeout 5s mà KHÔNG có thông điệp lỗi nào chỉ ra nguyên nhân; (2) chặn `then`
// rồi thì vitest vẫn từ chối vì nó kiểm export bằng `ownKeys`, mà Proxy không
// khai key nào. Thêm font mới thì thêm 1 dòng ở đây.
//
// `variable` là **TÊN CLASS** (thật: `__variable_a1b2c3`), KHÔNG phải tên biến
// CSS — class đó mới là nơi khai `--font-x`.
const mockFont = (name: string) => () => ({
  variable: `__variable_mock_${name}`,
  className: `__className_mock_${name}`,
  style: { fontFamily: name },
})

vi.mock('next/font/google', () => ({
  Inter: mockFont('Inter'),
  Montserrat: mockFont('Montserrat'),
  Be_Vietnam_Pro: mockFont('Be_Vietnam_Pro'),
}))

// "Tính năng của tổ chức": mặc định BẬT hết để test component KHÔNG cần
// QueryClientProvider. Test cần trạng thái khác thì `vi.mock('@/hooks/use-org-features', …)`
// trong chính file đó (đè lên mock này).
vi.mock('@/hooks/use-org-features', async () => {
  const { resolveOrgFeatures, isOrgFeatureOn } = await import('@trinity/rbac')
  const features = resolveOrgFeatures(undefined)
  return {
    ORG_FEATURES_KEY: ['settings', 'org-features'],
    useOrgFeatures: () => ({ features, isLoading: false, isResolved: true }),
    useOrgFeature: (key: Parameters<typeof isOrgFeatureOn>[1]) => isOrgFeatureOn(features, key),
    useUpdateOrgFeatures: () => ({ mutate: vi.fn(), isPending: false }),
  }
})

// Mock Next.js image
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}))

// jsdom không có `matchMedia` — `useIsPhone` (MobileFilterSheet…) cần nó.
// Mặc định "không phải điện thoại" (bố cục desktop).
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}
