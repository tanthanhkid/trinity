const VN_OFFSET_MS = 7 * 60 * 60 * 1000

/** Get current Date in Vietnam timezone (UTC+7) */
export function getVietnamTime(date?: Date): Date {
  const now = date ?? new Date()
  return new Date(now.getTime() + VN_OFFSET_MS)
}

/** Check if current time is within VN business hours (08:00-18:00) */
export function isBusinessHours(date?: Date): boolean {
  const vnTime = getVietnamTime(date)
  const hours = vnTime.getUTCHours()
  return hours >= 8 && hours < 18
}

/** Get next 8:00 AM Vietnam time as UTC Date */
export function getNextBusinessStart(date?: Date): Date {
  const now = date ?? new Date()
  const vnTime = getVietnamTime(now)
  const vnHours = vnTime.getUTCHours()

  // If before 8:00 VN today, next business start is today 8:00 VN
  // If 8:00+ VN today, next business start is tomorrow 8:00 VN
  const daysToAdd = vnHours < 8 ? 0 : 1

  const nextStart = new Date(vnTime)
  nextStart.setUTCDate(nextStart.getUTCDate() + daysToAdd)
  nextStart.setUTCHours(8, 0, 0, 0)

  // Convert back to UTC by subtracting VN offset
  return new Date(nextStart.getTime() - VN_OFFSET_MS)
}
