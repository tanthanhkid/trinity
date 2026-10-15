// API Response types
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  limit: number
  hasMore: boolean
}

export interface CursorPaginatedResponse<T> {
  data: T[]
  nextCursor: string | null
  hasMore: boolean
}

// Auth types
export interface LoginDto {
  email: string
  password: string
}

export interface TokenResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

// Notification
export type NotificationChannel = 'push' | 'in_app' | 'webhook'
