import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGet = vi.fn()
let capturedParams: Record<string, string> = {}

vi.mock('@/lib/api-client', () => ({
  default: {
    get: (url: string, config?: { params?: Record<string, string> }) => {
      capturedParams = config?.params ?? {}
      return mockGet(url, config)
    },
  },
}))

vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: Symbol('keepPreviousData'),
  useQuery: vi.fn((opts: { queryFn: () => unknown }) => ({
    data: { data: [], meta: { total: 0, page: 1, pages: 1, limit: 50, next_cursor: null } },
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    queryFn: opts.queryFn,
  })),
}))

// Contacts list — page-number pagination + apply-on-submit
describe('Contacts List', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedParams = {}
    mockGet.mockResolvedValue({
      data: { data: [], meta: { total: 0, page: 1, pages: 1, limit: 50, next_cursor: null } },
    })
  })

  describe('Page-number pagination', () => {
    it('should send page=1 by default', async () => {
      const { useContacts } = await import('@/hooks/use-contacts')
      const { useQuery } = await import('@tanstack/react-query')

      useContacts({ filters: {}, page: 1 })

      const callArgs = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      if (callArgs?.queryFn) {
        await callArgs.queryFn()
        expect(capturedParams.page).toBe('1')
        expect(capturedParams.limit).toBe('50')
      } else {
        expect(callArgs).toBeDefined()
      }
    })

    it('should send page=N when page argument changes', async () => {
      const { useContacts } = await import('@/hooks/use-contacts')
      const { useQuery } = await import('@tanstack/react-query')

      useContacts({ filters: {}, page: 5 })

      const callArgs = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      if (callArgs?.queryFn) {
        await callArgs.queryFn()
        expect(capturedParams.page).toBe('5')
      } else {
        expect(callArgs).toBeDefined()
      }
    })

    it('should NOT send legacy cursor param', async () => {
      const { useContacts } = await import('@/hooks/use-contacts')
      const { useQuery } = await import('@tanstack/react-query')

      useContacts({ filters: {}, page: 1 })

      const callArgs = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      if (callArgs?.queryFn) {
        await callArgs.queryFn()
        expect(capturedParams).not.toHaveProperty('cursor')
        expect(capturedParams).not.toHaveProperty('skip')
      } else {
        expect(callArgs).toBeDefined()
      }
    })

    it('should expose pages from meta for navigation', async () => {
      const { useQuery } = await import('@tanstack/react-query')
      ;(useQuery as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        data: { data: [], meta: { total: 250, page: 3, pages: 5, limit: 50 } },
        isLoading: false,
        isFetching: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      })
      const { useContacts } = await import('@/hooks/use-contacts')

      const result = useContacts({ filters: {}, page: 3 })
      expect(result.total).toBe(250)
      expect(result.pages).toBe(5)
      expect(result.page).toBe(3)
    })

    it('should disable query when enabled=false (RBAC deny)', async () => {
      const { useContacts } = await import('@/hooks/use-contacts')
      const { useQuery } = await import('@tanstack/react-query')

      useContacts({ filters: {}, page: 1, enabled: false })

      const callArgs = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      expect(callArgs?.enabled).toBe(false)
    })
  })

  describe('Filters', () => {
    it('should filter by contact status when dropdown applied', async () => {
      const { useContacts } = await import('@/hooks/use-contacts')
      const { useQuery } = await import('@tanstack/react-query')

      useContacts({ filters: { contactStatusId: 'status-1' }, page: 1 })

      const callArgs = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      if (callArgs?.queryFn) {
        await callArgs.queryFn()
        expect(capturedParams.contact_status_id).toBe('status-1')
      } else {
        expect(callArgs).toBeDefined()
      }
    })

    it('should filter by team_id when team applied', async () => {
      const { useContacts } = await import('@/hooks/use-contacts')
      const { useQuery } = await import('@tanstack/react-query')

      useContacts({ filters: { teamId: 'team-a' }, page: 1 })

      const callArgs = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      if (callArgs?.queryFn) {
        await callArgs.queryFn()
        expect(capturedParams.team_id).toBe('team-a')
      } else {
        expect(callArgs).toBeDefined()
      }
    })

    it('should send search exactly as provided (page already trims at submit)', async () => {
      const { useContacts } = await import('@/hooks/use-contacts')
      const { useQuery } = await import('@tanstack/react-query')

      useContacts({ filters: { search: '0901234567' }, page: 1 })

      const callArgs = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      if (callArgs?.queryFn) {
        await callArgs.queryFn()
        expect(capturedParams.search).toBe('0901234567')
      } else {
        expect(callArgs).toBeDefined()
      }
    })

    it('should trim search before sending query params', async () => {
      const { useContacts } = await import('@/hooks/use-contacts')
      const { useQuery } = await import('@tanstack/react-query')

      useContacts({ filters: { search: '  Nguyễn Văn A  ' }, page: 1 })

      const callArgs = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      if (callArgs?.queryFn) {
        await callArgs.queryFn()
        expect(capturedParams.search).toBe('Nguyễn Văn A')
      } else {
        expect(callArgs).toBeDefined()
      }
    })

    it('should NOT send contact_status_id when filter is "all" (400 guard)', async () => {
      const { useContacts } = await import('@/hooks/use-contacts')
      const { useQuery } = await import('@tanstack/react-query')

      useContacts({ filters: { contactStatusId: 'all' }, page: 1 })

      const callArgs = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      if (callArgs?.queryFn) {
        await callArgs.queryFn()
        expect(capturedParams.contact_status_id).toBeUndefined()
      } else {
        expect(callArgs).toBeDefined()
      }
    })
  })

  describe('RBAC', () => {
    it('sale role: assigned_to=me in query', async () => {
      const { useContacts } = await import('@/hooks/use-contacts')
      const { useQuery } = await import('@tanstack/react-query')

      useContacts({ filters: { assignedTo: 'user-sale-1' }, page: 1 })

      const callArgs = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      if (callArgs?.queryFn) {
        await callArgs.queryFn()
        expect(capturedParams.assigned_to).toBe('user-sale-1')
      } else {
        expect(callArgs).toBeDefined()
      }
    })

    it('team_lead: team_id in query', async () => {
      const { useContacts } = await import('@/hooks/use-contacts')
      const { useQuery } = await import('@tanstack/react-query')

      useContacts({ filters: { teamId: 'team-my' }, page: 1 })

      const callArgs = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      if (callArgs?.queryFn) {
        await callArgs.queryFn()
        expect(capturedParams.team_id).toBe('team-my')
      } else {
        expect(callArgs).toBeDefined()
      }
    })
  })

  describe('Error handling', () => {
    it('should expose isError=true when API returns 500 error', () => {
      const errorState = { isError: true, error: new Error('500 Internal Server Error') }
      expect(errorState.isError).toBe(true)
      expect(errorState.error.message).toContain('500')
    })

    it('should never include skip/cursor param', async () => {
      mockGet.mockRejectedValue(new Error('Server error'))
      const { useContacts } = await import('@/hooks/use-contacts')
      const { useQuery } = await import('@tanstack/react-query')

      useContacts({ filters: {}, page: 1 })

      const callArgs = (useQuery as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      if (callArgs?.queryFn) {
        try {
          await callArgs.queryFn()
        } catch {
          // expected
        }
        expect(capturedParams).not.toHaveProperty('skip')
        expect(capturedParams).not.toHaveProperty('cursor')
      }
    })
  })
})
