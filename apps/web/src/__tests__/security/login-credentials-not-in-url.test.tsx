import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

/**
 * Khoá bất biến: MẬT KHẨU KHÔNG BAO GIỜ ĐƯỢC LỌT VÀO URL.
 *
 * Bối cảnh: `<form>` của trang đăng nhập không khai `method` thì mặc định HTML
 * là **GET về chính URL hiện tại**. Trước khi React hydrate xong thì `onSubmit`
 * chưa gắn ⇒ bấm nút / gõ Enter chạy submit NATIVE và trình duyệt đi tới
 * `/login?email=…&password=…` — mật khẩu lọt vào URL, log truy cập và `Referer`.
 *
 * ⚠️ Vì sao test này KHÔNG mô phỏng "bấm trước khi hydrate": React Testing
 * Library luôn chạy effect ngay khi render, không dựng lại được cửa sổ chưa
 * hydrate. Nên ta khoá thẳng thứ khiến cửa sổ đó VÔ HẠI — thuộc tính `method`
 * của form. Đó cũng là lớp duy nhất còn đúng khi JS tắt hẳn.
 */

const mockLogin = vi.fn()

vi.mock('@/lib/auth-api', () => ({ login: mockLogin }))
vi.mock('@/lib/token-storage', () => ({
  getAccessToken: vi.fn(() => null),
  setAccessToken: vi.fn(),
  setRefreshToken: vi.fn(),
  clearTokens: vi.fn(),
}))
vi.mock('@/store/auth', () => ({
  useAuthStore: vi.fn(() => ({
    accessToken: null,
    setAuth: vi.fn(),
    clearAuth: vi.fn(),
  })),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() }, Toaster: () => null }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ clear: vi.fn() }) }))
vi.mock('@/lib/api-client', () => ({ resetLogoutState: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))

async function renderLogin() {
  const LoginPage = (await import('@/app/login/page')).default
  const view = render(<LoginPage />)
  const password = screen.getByLabelText('Mật khẩu') as HTMLInputElement
  const form = password.closest('form')
  if (!form) throw new Error('Không tìm thấy <form> bọc ô mật khẩu')
  return { view, form, password }
}

describe('Đăng nhập — thông tin đăng nhập không được lọt vào URL', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('form đăng nhập PHẢI khai method="post" (submit native gửi trong thân, không vào query string)', async () => {
    const { form } = await renderLogin()
    // `form.method` của DOM trả 'get' khi KHÔNG khai thuộc tính — đúng cái đã rò.
    expect(form.method).toBe('post')
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post')
  })

  it('ô mật khẩu nằm TRONG form đó — nếu không, khẳng định ở trên vô nghĩa', async () => {
    const { form, password } = await renderLogin()
    expect(form.contains(password)).toBe(true)
    expect(password.name).toBe('password')
  })

  it('KHÔNG có form nào khác trên trang mang field mật khẩu mà lại submit GET', async () => {
    await renderLogin()
    const leaky = Array.from(document.querySelectorAll('form')).filter(
      (f) =>
        f.querySelector('input[type="password"], input[name="password"]') !== null &&
        (f.getAttribute('method') ?? 'get').toLowerCase() === 'get',
    )
    expect(leaky.map((f) => f.outerHTML.slice(0, 80))).toEqual([])
  })

  it('nút submit mở khoá sau khi hydrate — bản vá KHÔNG được khoá chết đường đăng nhập', async () => {
    // Bảo vệ đúng rủi ro của chính bản vá: nếu cờ gate chọn nhầm (vd cờ
    // rehydrate của Zustand) mà kẹt false thì không ai đăng nhập được nữa.
    await renderLogin()
    const btn = screen.getByRole('button', { name: /đăng nhập/i }) as HTMLButtonElement
    await waitFor(() => expect(btn.disabled).toBe(false))
  })
})
