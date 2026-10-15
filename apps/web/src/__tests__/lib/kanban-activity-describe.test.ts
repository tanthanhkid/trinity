import { describe, expect, it } from "vitest"
import { KANBAN_ACTIVITY_ACTIONS, type KanbanCardActivity } from "@/types/kanban"
import {
  ACTIVITY_LABELS,
  ACTIVITY_TONE,
  activityLabel,
  describeActivity,
} from "@/components/kanban/kanban-activity-describe"

const mk = (action: string, payload: Record<string, unknown> = {}): KanbanCardActivity =>
  ({ id: 1, action, payload, actor_name: "A", created_at: "2026-09-30T00:00:00Z" }) as unknown as KanbanCardActivity

const colName = (id: unknown) => (id === 1 ? "Mới" : "đã xoá")

describe("kanban-activity-describe", () => {
  it("mọi action BE đều có nhãn + tone", () => {
    for (const a of KANBAN_ACTIVITY_ACTIONS) {
      expect(ACTIVITY_LABELS[a]).toBeTruthy()
      expect(ACTIVITY_TONE[a]).toBeTruthy()
    }
  })

  it("action lạ rơi về nhãn chung, không in mã thô", () => {
    expect(activityLabel("zzz_new")).toBe("Hoạt động khác")
    expect(describeActivity(mk("zzz_new"), colName)).toBe("Hoạt động khác")
  })

  it("moved dùng tên cột, cột đã xoá không lộ id", () => {
    expect(describeActivity(mk("moved", { from_column_id: 1, to_column_id: 9 }), colName)).toBe(
      'Chuyển từ cột "Mới" sang cột "đã xoá"',
    )
  })

  it("updated map tên field sang tiếng Việt, field lạ -> thông tin khác, payload thiếu không văng", () => {
    expect(describeActivity(mk("updated", { fields: ["due_at", "assignee_ids", "assignee_id", "x"] }), colName)).toBe(
      "Sửa hạn xử lý, người phụ trách, thông tin khác",
    )
    expect(describeActivity(mk("updated"), colName)).toBe("Cập nhật card")
  })
})
