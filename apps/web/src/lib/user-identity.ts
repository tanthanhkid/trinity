interface UserIdentity {
  id?: number | string | null
  full_name?: string | null
  email?: string | null
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function formatUserIdFallback(id: number | string | null | undefined): string | null {
  if (id === null || id === undefined || id === "") return null
  const numericId = typeof id === "number" ? id : Number.parseInt(id, 10)
  if (!Number.isFinite(numericId) || numericId <= 0) return null
  return `Người dùng #${numericId}`
}

export function getUserDisplayName(
  user: UserIdentity | null | undefined,
  fallback?: string,
): string {
  if (!user) return cleanText(fallback) ?? "—"

  return (
    cleanText(user.full_name) ??
    cleanText(user.email) ??
    cleanText(fallback) ??
    formatUserIdFallback(user.id) ??
    "—"
  )
}

export function getUserEmail(
  user: Pick<UserIdentity, "email"> | null | undefined,
): string | null {
  return cleanText(user?.email)
}

export function getUserEmailTooltip(
  user: Pick<UserIdentity, "full_name" | "email"> | null | undefined,
): string | undefined {
  const name = cleanText(user?.full_name)
  const email = cleanText(user?.email)
  return name && email ? email : undefined
}

export function getUserAriaLabel(
  user: UserIdentity | null | undefined,
  fallback?: string,
): string {
  const displayName = getUserDisplayName(user, fallback)
  const email = getUserEmailTooltip(user)
  return email ? `${displayName} (${email})` : displayName
}
