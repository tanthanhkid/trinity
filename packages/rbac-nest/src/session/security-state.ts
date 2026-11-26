import { clientForSchema, currentCompany } from '@trinity/prisma'
type PrismaClient = ReturnType<typeof clientForSchema>

/**
 * Lưu bền blacklist token và phiên đang sống (G12b). RAM + NOTIFY là lớp nhanh; bảng này là sự thật khi tiến trình khởi
 * động lại hoặc nối lại kênh NOTIFY (tin trong lúc đứt đã mất). Mọi hàm chạy trong ngữ cảnh công ty hiện tại và KHÔNG ném:
 * lỗi DB chỉ ghi log (đăng nhập/đăng xuất không được hỏng vì bảng phụ).
 */
/** Client của công ty hiện tại; chưa dựng PrismaService (test đơn vị không DB) ⇒ null, các hàm lặng lẽ bỏ qua. */
function client(): PrismaClient | null {
  try { return clientForSchema(currentCompany()?.schema ?? 'public') } catch { return null }
}
const db = (): PrismaClient => { const c = client(); if (!c) throw new NoDb(); return c }
class NoDb extends Error {}
const warn = (what: string, e: unknown): void => e instanceof NoDb ? undefined : console.warn(`[security-state] ${what}: ${e instanceof Error ? e.message : String(e)}`)

export interface BlockedRow { user_id: number; expires_at: Date; updated_at: Date }
export interface SessionRow { user_id: number; session_id: string; started_at: Date }

export async function saveBlock(userId: number, expiresAt: Date): Promise<void> {
  try {
    await db().$executeRaw`INSERT INTO token_blacklist (user_id, expires_at, updated_at) VALUES (${userId}, ${expiresAt}, now())
      ON CONFLICT (user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, updated_at = now()`
  } catch (e) { warn('ghi blacklist', e) }
}

export async function deleteBlock(userId: number): Promise<void> {
  try { await db().$executeRaw`DELETE FROM token_blacklist WHERE user_id = ${userId}` } catch (e) { warn('xoá blacklist', e) }
}

export async function loadBlocks(): Promise<BlockedRow[]> {
  try {
    await db().$executeRaw`DELETE FROM token_blacklist WHERE expires_at < now()`
    return await db().$queryRaw<BlockedRow[]>`SELECT user_id, expires_at, updated_at FROM token_blacklist`
  } catch (e) { warn('nạp blacklist', e); return [] }
}

export async function saveSession(userId: number, sessionId: string): Promise<void> {
  try {
    await db().$executeRaw`INSERT INTO active_sessions (user_id, session_id, started_at) VALUES (${userId}, ${sessionId}, now())
      ON CONFLICT (user_id) DO UPDATE SET session_id = EXCLUDED.session_id, started_at = now()`
  } catch (e) { warn('ghi phiên', e) }
}

export async function deleteSession(userId: number): Promise<void> {
  try { await db().$executeRaw`DELETE FROM active_sessions WHERE user_id = ${userId}` } catch (e) { warn('xoá phiên', e) }
}

export async function loadSessions(): Promise<SessionRow[]> {
  try { return await db().$queryRaw<SessionRow[]>`SELECT user_id, session_id, started_at FROM active_sessions` } catch (e) { warn('nạp phiên', e); return [] }
}
