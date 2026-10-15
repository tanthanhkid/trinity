const ACCESS_TOKEN_KEY = 'trinity_access_token'
const REFRESH_TOKEN_KEY = 'trinity_refresh_token'
const COOKIE_ACCESS_TOKEN = 'access_token'

function isClient(): boolean {
  return typeof window !== 'undefined'
}

export function getAccessToken(): string | null {
  if (!isClient()) return null
  return localStorage.getItem(ACCESS_TOKEN_KEY)
}

export function setAccessToken(token: string): void {
  if (!isClient()) return
  localStorage.setItem(ACCESS_TOKEN_KEY, token)
  // Also set cookie so Next.js middleware can read it (middleware runs server-side)
  document.cookie = `${COOKIE_ACCESS_TOKEN}=${token}; path=/; max-age=900; SameSite=Lax`
}

export function getRefreshToken(): string | null {
  if (!isClient()) return null
  return localStorage.getItem(REFRESH_TOKEN_KEY)
}

export function setRefreshToken(token: string): void {
  if (!isClient()) return
  localStorage.setItem(REFRESH_TOKEN_KEY, token)
  // Set a long-lived session cookie (7d matching refresh token) so middleware knows session exists
  document.cookie = `has_session=1; path=/; max-age=604800; SameSite=Lax`
}

export function clearTokens(): void {
  if (!isClient()) return
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  // Clear the access_token cookie
  document.cookie = `${COOKIE_ACCESS_TOKEN}=; path=/; max-age=0; SameSite=Lax`
  document.cookie = `has_session=; path=/; max-age=0; SameSite=Lax`
}
