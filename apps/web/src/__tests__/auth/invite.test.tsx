import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const mockPreview = vi.fn()
const mockAccept = vi.fn()
const mockPush = vi.fn()

const mockMethods = vi.fn()
const mockSendCode = vi.fn()
const mockAcceptCode = vi.fn()
vi.mock('@/lib/auth-api', () => ({
  previewInvitation: (t: string) => mockPreview(t),
  acceptInvitation: (i: unknown) => mockAccept(i),
  getLoginMethods: () => mockMethods(),
  sendInvitationCode: (t: string) => mockSendCode(t),
  acceptInvitationWithCode: (i: unknown) => mockAcceptCode(i),
}))
vi.mock('@/lib/token-storage', () => ({ setAccessToken: vi.fn(), setRefreshToken: vi.fn(), clearTokens: vi.fn() }))
const mockSetAuth = vi.fn()
vi.mock('@/store/auth', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ setAuth: mockSetAuth, clearAuth: vi.fn() }),
}))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ clear: vi.fn() }) }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  useParams: () => ({ token: 'c3.AbCd-_9' }),
  usePathname: () => '/invite/c3.AbCd-_9',
}))
vi.mock('../../app/login/_components/login-brand-panel', () => ({ LoginBrandPanel: () => null }))

import InvitePage from '../../app/invite/[token]/page'

const invite = { company_name: 'Công ty A', email: 'nv@x.vn', role_name: 'Nhân viên', expires_at: '2026-12-03T00:00:00Z' }

beforeEach(() => {
  vi.clearAllMocks()
  // Mặc định máy chủ không gửi được mail ⇒ đặt mật khẩu như trước.
  mockMethods.mockResolvedValue({ email_login_enabled: false, google_enabled: false, password_login_enabled: true })
})

describe('trang nhận lời mời /invite/[token]', () => {
  it('hiện công ty, email, vai trò; đặt tên + mật khẩu rồi vào Tổng quan', async () => {
    mockPreview.mockResolvedValue(invite)
    mockAccept.mockResolvedValue({ user: {}, roles: [], permissions: {}, isAdmin: false, company: { id: 3 }, tokens: { accessToken: 'a', refreshToken: 'r' } })
    render(<InvitePage />)
    expect(await screen.findByText(/Tham gia Công ty A/)).toBeInTheDocument()
    expect(mockPreview).toHaveBeenCalledWith('c3.AbCd-_9')
    expect(screen.getByText('nv@x.vn')).toBeInTheDocument()
    expect(screen.getByText('Nhân viên')).toBeInTheDocument()

    fireEvent.change(await screen.findByLabelText('Họ tên của bạn'), { target: { value: 'Nguyễn Văn B' } })
    fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: 'matkhau-moi-1' } })
    fireEvent.change(screen.getByLabelText('Nhập lại mật khẩu'), { target: { value: 'matkhau-moi-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tham gia' }))
    await waitFor(() => expect(mockAccept).toHaveBeenCalledWith({ token: 'c3.AbCd-_9', full_name: 'Nguyễn Văn B', password: 'matkhau-moi-1' }))
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'))
    expect(mockSetAuth).toHaveBeenCalled()
  })

  it('hai mật khẩu khác nhau thì không gửi', async () => {
    mockPreview.mockResolvedValue(invite)
    render(<InvitePage />)
    await screen.findByRole("heading", { name: /Tham gia/ })
    fireEvent.change(await screen.findByLabelText('Họ tên của bạn'), { target: { value: 'Nguyễn Văn B' } })
    fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: 'matkhau-moi-1' } })
    fireEvent.change(screen.getByLabelText('Nhập lại mật khẩu'), { target: { value: 'khac-hoan-toan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tham gia' }))
    expect(await screen.findByText('Hai mật khẩu chưa giống nhau')).toBeInTheDocument()
    expect(mockAccept).not.toHaveBeenCalled()
  })

  it('link hết hạn / đã dùng: báo rõ, không có form', async () => {
    mockPreview.mockRejectedValue({ isAxiosError: true, response: { status: 410, data: { message: 'Lời mời không còn hiệu lực (đã dùng, đã bị huỷ hoặc hết hạn). Hãy nhờ chủ công ty gửi link mới.' } } })
    render(<InvitePage />)
    expect(await screen.findByText(/không còn hiệu lực/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Mật khẩu')).toBeNull()
  })

  it('máy chủ gửi được mail: nhập tên, nhận mã ở email được mời, dán mã là vào — không cần mật khẩu', async () => {
    mockMethods.mockResolvedValue({ email_login_enabled: true, google_enabled: false, password_login_enabled: true })
    mockPreview.mockResolvedValue(invite)
    mockSendCode.mockResolvedValue({ email: 'n***@x.vn', expires_in: 600, resend_after: 30 })
    mockAcceptCode.mockResolvedValue({ user: {}, roles: [], permissions: {}, isAdmin: false, company: { id: 3 }, tokens: { accessToken: 'a', refreshToken: 'r' } })
    render(<InvitePage />)
    fireEvent.change(await screen.findByLabelText('Họ tên của bạn'), { target: { value: 'Nguyễn Văn C' } })
    expect(screen.queryByLabelText('Mật khẩu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Gửi mã xác nhận' }))
    await waitFor(() => expect(mockSendCode).toHaveBeenCalledWith('c3.AbCd-_9'))
    expect(await screen.findByText('n***@x.vn')).toBeInTheDocument()
    expect(screen.getByText(/Gửi lại sau 30 s/)).toBeInTheDocument()
    fireEvent.paste(screen.getByLabelText('Chữ số 1'), { clipboardData: { getData: () => ' 123 456 ' } })
    await waitFor(() => expect(mockAcceptCode).toHaveBeenCalledWith({ token: 'c3.AbCd-_9', full_name: 'Nguyễn Văn C', code: '123456' }))
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'))
  })

  it('luồng mã: vẫn chọn được đặt mật khẩu', async () => {
    mockMethods.mockResolvedValue({ email_login_enabled: true, google_enabled: false, password_login_enabled: true })
    mockPreview.mockResolvedValue(invite)
    render(<InvitePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Đặt mật khẩu thay vì nhận mã' }))
    expect(await screen.findByLabelText('Mật khẩu')).toBeInTheDocument()
  })
})
