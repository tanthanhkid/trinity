import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

/** #675: màn đăng nhập email + Google, màn nhập mã 6 ô, trang nhận phiên từ link/vé. */

const mockMethods = vi.fn()
const mockStart = vi.fn()
const mockVerify = vi.fn()
const mockLogin = vi.fn()
const mockRedeemLink = vi.fn()
const mockRedeemTicket = vi.fn()
const mockPush = vi.fn()
const mockReplace = vi.fn()
const mockSetAuth = vi.fn()

vi.mock('@/lib/auth-api', () => ({
  login: (...a: unknown[]) => mockLogin(...a),
  isSignupEnabled: () => Promise.resolve(false),
  getLoginMethods: () => mockMethods(),
  googleStartUrl: (next?: string | null) => `/api/v1/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ''}`,
  startEmailLogin: (e: string) => mockStart(e),
  verifyEmailCode: (e: string, c: string) => mockVerify(e, c),
  redeemEmailLink: (t: string) => mockRedeemLink(t),
  redeemLoginTicket: (t: string) => mockRedeemTicket(t),
}))
vi.mock('@/lib/token-storage', () => ({
  getAccessToken: vi.fn(() => null),
  setAccessToken: vi.fn(),
  setRefreshToken: vi.fn(),
  clearTokens: vi.fn(),
}))
vi.mock('@/store/auth', () => {
  const state = { accessToken: null, setAuth: (...a: unknown[]) => mockSetAuth(...a), clearAuth: vi.fn(), _hasHydrated: false }
  return { useAuthStore: (sel?: (s: unknown) => unknown) => (sel ? sel(state) : state) }
})
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ clear: vi.fn() }) }))
vi.mock('@/lib/api-client', () => ({ resetLogoutState: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush, replace: mockReplace }) }))

const ALL_ON = { email_login_enabled: true, google_enabled: true, password_login_enabled: true, signup_enabled: false, code_length: 6, resend_after: 30, expires_in: 600 }
const RESULT = { user: { id: 1 }, roles: [], permissions: {}, isAdmin: false, company: { id: 1 }, tokens: { accessToken: 'a', refreshToken: 'r' } }

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/login')
})

async function renderLogin() {
  const LoginPage = (await import('@/app/login/page')).default
  return render(<LoginPage />)
}

describe('màn /login không mật khẩu', () => {
  it('chỉ có ô email, nút email và nút Google; mật khẩu là đường phụ', async () => {
    mockMethods.mockResolvedValue(ALL_ON)
    await renderLogin()
    expect(await screen.findByRole('button', { name: /Tiếp tục với email/ })).toBeTruthy()
    const google = screen.getByRole('link', { name: /Tiếp tục với Google/ })
    expect(google.getAttribute('href')).toBe('/api/v1/auth/google/start')
    const email = screen.getByLabelText('Email')
    expect(email.getAttribute('autocomplete')).toBe('email')
    expect(screen.queryByLabelText('Mật khẩu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập bằng mật khẩu' }))
    expect(await screen.findByLabelText('Mật khẩu')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Đăng nhập bằng mã gửi qua email' })).toBeTruthy()
  })

  it('không SMTP, không Google: chỉ form mật khẩu, không nút Google', async () => {
    mockMethods.mockResolvedValue({ ...ALL_ON, email_login_enabled: false, google_enabled: false })
    await renderLogin()
    expect(await screen.findByLabelText('Mật khẩu')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Google/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Tiếp tục với email/ })).toBeNull()
  })

  it('gửi mã → màn 6 ô: báo email đã che, đếm ngược, dán một lần là tự đăng nhập', async () => {
    mockMethods.mockResolvedValue(ALL_ON)
    mockStart.mockResolvedValue({ message: 'x', email: 'a***@gmail.com', expires_in: 600, resend_after: 30 })
    mockVerify.mockResolvedValue(RESULT)
    await renderLogin()
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: '  Anh@Gmail.com ' } })
    fireEvent.click(screen.getByRole('button', { name: /Tiếp tục với email/ }))
    await waitFor(() => expect(mockStart).toHaveBeenCalledWith('anh@gmail.com'))
    expect(await screen.findByText('a***@gmail.com')).toBeTruthy()
    expect(screen.getByText('Gửi lại sau 30 s')).toBeTruthy()
    expect(screen.getByLabelText('Chữ số 1').getAttribute('autocomplete')).toBe('one-time-code')
    fireEvent.paste(screen.getByLabelText('Chữ số 1'), { clipboardData: { getData: () => 'Mã: 654321' } })
    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith('anh@gmail.com', '654321'))
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'))
    expect(mockSetAuth).toHaveBeenCalled()
  })

  it('sai mã: báo câu máy chủ (còn n lần), xoá ô; "Dùng email khác" quay lại', async () => {
    mockMethods.mockResolvedValue(ALL_ON)
    mockStart.mockResolvedValue({ message: 'x', email: 'a***@gmail.com', expires_in: 600, resend_after: 30 })
    mockVerify.mockRejectedValue({ isAxiosError: true, response: { status: 400, data: { message: 'Mã không đúng. Bạn còn 4 lần thử.' } } })
    await renderLogin()
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'anh@gmail.com' } })
    fireEvent.click(screen.getByRole('button', { name: /Tiếp tục với email/ }))
    await screen.findByText('a***@gmail.com')
    for (const [i, d] of ['1', '2', '3', '4', '5', '6'].entries()) {
      fireEvent.change(screen.getByLabelText(`Chữ số ${i + 1}`), { target: { value: d } })
    }
    expect(await screen.findByText('Mã không đúng. Bạn còn 4 lần thử.')).toBeTruthy()
    expect((screen.getByLabelText('Chữ số 1') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: /Dùng email khác/ }))
    expect(await screen.findByRole('button', { name: /Tiếp tục với email/ })).toBeTruthy()
  })

  it('mã hết hạn: cho gửi lại ngay', async () => {
    mockMethods.mockResolvedValue(ALL_ON)
    mockStart.mockResolvedValue({ message: 'x', email: 'a***@gmail.com', expires_in: 600, resend_after: 30 })
    mockVerify.mockRejectedValue({ isAxiosError: true, response: { status: 400, data: { message: 'Mã đã hết hạn (10 phút). Hãy gửi lại mã mới.' } } })
    await renderLogin()
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'anh@gmail.com' } })
    fireEvent.click(screen.getByRole('button', { name: /Tiếp tục với email/ }))
    await screen.findByText('a***@gmail.com')
    fireEvent.paste(screen.getByLabelText('Chữ số 1'), { clipboardData: { getData: () => '111111' } })
    expect(await screen.findByRole('button', { name: 'Gửi lại mã' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Gửi lại mã' }))
    await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/Đã gửi mã mới/)).toBeTruthy()
  })

  it('Google báo lỗi qua URL: hiện câu của máy chủ', async () => {
    window.history.replaceState(null, '', '/login?error=google&message=Email%20Google%20n%C3%A0y%20ch%C6%B0a%20c%C3%B3%20t%C3%A0i%20kho%E1%BA%A3n')
    mockMethods.mockResolvedValue(ALL_ON)
    await renderLogin()
    expect(await screen.findByText('Email Google này chưa có tài khoản')).toBeTruthy()
  })

  it('đang dở cấp quyền AI (`next=/oauth/authorize…`): nút Google mang theo next', async () => {
    window.history.replaceState(null, '', '/login?next=%2Foauth%2Fauthorize%3Fclient_id%3Dx')
    mockMethods.mockResolvedValue(ALL_ON)
    await renderLogin()
    const google = await screen.findByRole('link', { name: /Tiếp tục với Google/ })
    expect(google.getAttribute('href')).toBe('/api/v1/auth/google/start?next=%2Foauth%2Fauthorize%3Fclient_id%3Dx')
  })
})

describe('trang nhận phiên /auth/email và /auth/complete', () => {
  it('link trong thư: đọc token ở fragment, xoá khỏi URL, đăng nhập rồi vào Tổng quan', async () => {
    window.history.replaceState(null, '', '/auth/email#token=c2.bimat')
    mockRedeemLink.mockResolvedValue(RESULT)
    const Page = (await import('@/app/auth/email/page')).default
    render(<Page />)
    await waitFor(() => expect(mockRedeemLink).toHaveBeenCalledWith('c2.bimat'))
    expect(window.location.hash).toBe('')
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard'))
    expect(mockSetAuth).toHaveBeenCalled()
  })

  it('link đã dùng: báo rõ, có đường về đăng nhập', async () => {
    window.history.replaceState(null, '', '/auth/email#token=cu')
    mockRedeemLink.mockRejectedValue({ isAxiosError: true, response: { status: 400, data: { message: 'Link đăng nhập không hợp lệ, đã dùng hoặc đã hết hạn. Hãy gửi lại mã mới.' } } })
    const Page = (await import('@/app/auth/email/page')).default
    render(<Page />)
    expect(await screen.findByText(/đã dùng hoặc đã hết hạn/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Về trang đăng nhập' })).toBeTruthy()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('sau Google: đổi vé lấy phiên, chỉ theo next nội bộ hợp lệ', async () => {
    window.history.replaceState(null, '', '/auth/complete#ticket=ve1&next=%2F%2Fevil.example')
    mockRedeemTicket.mockResolvedValue(RESULT)
    const Page = (await import('@/app/auth/complete/page')).default
    render(<Page />)
    await waitFor(() => expect(mockRedeemTicket).toHaveBeenCalledWith('ve1'))
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard'))
  })
})
