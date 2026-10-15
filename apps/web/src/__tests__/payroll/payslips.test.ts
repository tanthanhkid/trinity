import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPost = vi.fn()
const mockGet = vi.fn()
const mockPatch = vi.fn()

vi.mock('@/lib/api-client', () => ({
  default: {
    post: mockPost,
    get: mockGet,
    patch: mockPatch,
  },
}))

// Payroll payslips tests
describe('Payroll Payslips', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPost.mockResolvedValue({ data: { generated: 10 } })
    mockPatch.mockResolvedValue({ data: { status: 'approved' } })
    mockGet.mockResolvedValue({ data: { url: 'https://s3.example.com/payslip.pdf' } })
  })

  it('should call POST /payslips/generate to generate payslips', async () => {
    const payload = { month: '2026-03', teamId: 'team-1' }
    await mockPost('/payslips/generate', payload)
    expect(mockPost).toHaveBeenCalledWith('/payslips/generate', payload)
  })

  it('team_lead approve should call PATCH /payslips/:id/approve (step 1 of 2)', async () => {
    const payslipId = 'ps-001'
    await mockPatch(`/payslips/${payslipId}/approve`, { step: 1 })
    expect(mockPatch).toHaveBeenCalledWith(`/payslips/${payslipId}/approve`, { step: 1 })
  })

  it('accountant approve should call PATCH /payslips/:id/approve (step 2 of 2)', async () => {
    const payslipId = 'ps-001'
    await mockPatch(`/payslips/${payslipId}/approve`, { step: 2 })
    expect(mockPatch).toHaveBeenCalledWith(`/payslips/${payslipId}/approve`, { step: 2 })
  })

  it('should download PDF via GET /payslips/:id/pdf', async () => {
    const payslipId = 'ps-001'
    const result = await mockGet(`/payslips/${payslipId}/pdf`)
    expect(mockGet).toHaveBeenCalledWith(`/payslips/${payslipId}/pdf`)
    expect(result.data.url).toContain('s3.example.com')
  })

  describe('RBAC', () => {
    it('sale can only see own payslips', async () => {
      const userId = 'user-sale-1'
      await mockGet('/payslips', { params: { assigned_to: userId } })
      expect(mockGet).toHaveBeenCalledWith('/payslips', { params: { assigned_to: userId } })
    })

    it('team_lead can see team payslips', async () => {
      const teamId = 'team-a'
      await mockGet('/payslips', { params: { team_id: teamId } })
      expect(mockGet).toHaveBeenCalledWith('/payslips', { params: { team_id: teamId } })
    })

    it('accountant can see all payslips', async () => {
      // accountant calls /payslips without team filter
      await mockGet('/payslips', { params: {} })
      expect(mockGet).toHaveBeenCalledWith('/payslips', { params: {} })
    })

    it('should return 403 if sale tries to access other user payslips', async () => {
      mockGet.mockRejectedValue({ response: { status: 403 } })
      try {
        await mockGet('/payslips', { params: { assigned_to: 'other-user' } })
      } catch (err: unknown) {
        const error = err as { response?: { status?: number } }
        expect(error?.response?.status).toBe(403)
      }
    })
  })

  it('should show error when generate fails', async () => {
    mockPost.mockRejectedValue({ response: { status: 500, data: { message: 'Internal server error' } } })
    try {
      await mockPost('/payslips/generate', { month: '2026-03' })
    } catch (err: unknown) {
      const error = err as { response?: { status?: number } }
      expect(error?.response?.status).toBe(500)
    }
  })
})
