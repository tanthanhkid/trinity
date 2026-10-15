import type { PrismaClient } from '@prisma/client'

/**
 * Bảng công việc mặc định cho bản cài mới — để tạo việc (web hoặc MCP `create_task`) chạy được ngay,
 * không phải dựng bảng trước. `visibility_role_ids = []` ⇒ MỌI vai trò thấy bảng.
 *
 * Idempotent: chỉ tạo khi hệ thống CHƯA TỪNG có bảng nào (đếm cả bảng đã xoá mềm) — chạy seed lại
 * không nhân bản, và quản trị đã xoá hết bảng thì seed không tự dựng lại sau lưng họ.
 */
export const DEFAULT_KANBAN_BOARD = {
  name: 'Việc của tôi',
  description: 'Bảng công việc mặc định: Cần làm → Đang làm → Xong.',
  columns: [
    { name: 'Cần làm', is_done: false },
    { name: 'Đang làm', is_done: false },
    { name: 'Xong', is_done: true },
  ],
} as const

/** Khoảng cách vị trí cột — cùng giá trị `KANBAN_POSITION_GAP` của services/crm. */
const POSITION_GAP = 1024

type KanbanSeedClient = Pick<PrismaClient, 'kanbanBoard'>

export async function seedDefaultKanbanBoard(prisma: KanbanSeedClient, createdBy: number | null): Promise<boolean> {
  const existing = await prisma.kanbanBoard.count()
  if (existing > 0) return false
  await prisma.kanbanBoard.create({
    data: {
      name: DEFAULT_KANBAN_BOARD.name,
      description: DEFAULT_KANBAN_BOARD.description,
      created_by: createdBy,
      columns: {
        create: DEFAULT_KANBAN_BOARD.columns.map((c, i) => ({ name: c.name, is_done: c.is_done, position: (i + 1) * POSITION_GAP })),
      },
    },
  })
  return true
}
