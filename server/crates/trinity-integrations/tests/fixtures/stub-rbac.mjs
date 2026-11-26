// Bản sao nguyên văn `maskPhone` của packages/rbac-nest/src/scope-where.ts (để chạy `webhook-payload.ts` không cần dựng cả monorepo).
export function maskPhone(phone) {
  if (!phone) return phone
  const d = phone.replace(/\D/g, '')
  return d.length <= 3 ? '***' : `***${d.slice(-3)}`
}
