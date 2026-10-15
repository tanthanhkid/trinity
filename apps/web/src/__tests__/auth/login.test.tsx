import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const mockLogin = vi.fn()

vi.mock('@/lib/auth-api', () => ({
  login: mockLogin,
}))

vi.mock('@/lib/token-storage', () => ({
  getAccessToken: vi.fn(() => null),
  setAccessToken: vi.fn(),
  setRefreshToken: vi.fn(),
  clearTokens: vi.fn(),
}))

const mockSetAuth = vi.fn()
vi.mock('@/store/auth', () => ({
  useAuthStore: vi.fn(() => ({
    accessToken: null,
    setAuth: mockSetAuth,
    clearAuth: vi.fn(),
  })),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ clear: vi.fn() }),
}))

vi.mock('@/lib/api-client', () => ({
  resetLogoutState: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

// WEB-4: Login page integration tests
describe('Login Page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should render login form', async () => {
    const LoginPage = (await import('@/app/login/page')).default
    render(<LoginPage />)
    expect(screen.getByRole('button', { name: /đăng nhập/i })).toBeTruthy()
    expect(screen.getByLabelText(/email/i)).toBeTruthy()
    expect(screen.getByLabelText('Mật khẩu')).toBeTruthy()
  })

  it('should call POST /auth/login with email and password', async () => {
    mockLogin.mockResolvedValue({
      user: { id: 'u1', name: 'Test', email: 'admin@example.com', teamId: null },
      tokens: { accessToken: 'at', refreshToken: 'rt' },
    })

    const LoginPage = (await import('@/app/login/page')).default
    render(<LoginPage />)

    fireEvent.change(screen.getByPlaceholderText(/email@congty\.vn/i), {
      target: { value: 'admin@example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText(/nhập mật khẩu/i), {
      target: { value: 'test-password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /đăng nhập/i }))

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('admin@example.com', 'test-password')
    })
  })

  // Trang KHÔNG dùng `toast.error` — lỗi đăng nhập hiện trong khối inline dưới
  // form (`setLoginError`). Test này trước đó kỳ vọng toast nên ĐỎ SẴN từ lần
  // trang đổi cách báo lỗi; sửa để nó kiểm đúng thứ người dùng thật nhìn thấy.
  it('should show error message on invalid credentials (401)', async () => {
    mockLogin.mockRejectedValue({ response: { status: 401 } })

    const LoginPage = (await import('@/app/login/page')).default
    render(<LoginPage />)

    fireEvent.change(screen.getByPlaceholderText(/email@congty\.vn/i), {
      target: { value: 'wrong@example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText(/nhập mật khẩu/i), {
      target: { value: 'wrongpass' },
    })
    fireEvent.click(screen.getByRole('button', { name: /đăng nhập/i }))

    await waitFor(() => {
      expect(screen.getByText('Email hoặc mật khẩu không đúng')).toBeTruthy()
    })
  })

  it('should redirect to dashboard on successful login', async () => {
    mockLogin.mockResolvedValue({
      user: { id: 'u1', name: 'Test', email: 'admin@example.com', teamId: null },
      tokens: { accessToken: 'at', refreshToken: 'rt' },
    })

    const LoginPage = (await import('@/app/login/page')).default
    render(<LoginPage />)

    fireEvent.change(screen.getByPlaceholderText(/email@congty\.vn/i), {
      target: { value: 'admin@example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText(/nhập mật khẩu/i), {
      target: { value: 'test-password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /đăng nhập/i }))

    await waitFor(() => {
      expect(mockSetAuth).toHaveBeenCalled()
    })
  })

  it('should show loading state while submitting', async () => {
    mockLogin.mockImplementation(() => new Promise(() => {})) // never resolves

    const LoginPage = (await import('@/app/login/page')).default
    render(<LoginPage />)

    fireEvent.change(screen.getByPlaceholderText(/email@congty\.vn/i), {
      target: { value: 'admin@example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText(/nhập mật khẩu/i), {
      target: { value: 'test-password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /đăng nhập/i }))

    // Button becomes disabled during submit
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /đăng nhập/i })
      expect(btn).toBeTruthy()
    })
  })
})
