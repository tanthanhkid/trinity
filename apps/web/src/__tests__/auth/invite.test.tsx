import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const mockPreview = vi.fn()
const mockAccept = vi.fn()
const mockPush = vi.fn()

vi.mock('@/lib/auth-api', () => ({
  previewInvitation: (t: string) => mockPreview(t),
  acceptInvitation: (i: unknown) => mockAccept(i),
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
}))
vi.mock('../../app/login/_components/login-brand-panel', () => ({ LoginBrandPanel: () => null }))

import InvitePage from '../../app/invite/[token]/page'

const invite = { company_name: 'Công ty A', email: 'nv@x.vn', role_name: 'Nhân viên', expires_at: '2026-12-03T00:00:00Z' }

beforeEach(() => {
  vi.clearAllMocks()
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

    fireEvent.change(screen.getByLabelText('Họ tên của bạn'), { target: { value: 'Nguyễn Văn B' } })
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
    fireEvent.change(screen.getByLabelText('Họ tên của bạn'), { target: { value: 'Nguyễn Văn B' } })
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
})
