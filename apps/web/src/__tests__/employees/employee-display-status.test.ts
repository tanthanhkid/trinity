import { describe, it, expect } from "vitest"
import { resolveEmployeeDisplayStatus } from "@/hooks/use-employees"

describe("resolveEmployeeDisplayStatus", () => {
  it("tài khoản bị khóa = đã nghỉ việc → luôn 'resigned' bất kể employee.status", () => {
    expect(resolveEmployeeDisplayStatus("active", "locked")).toBe("resigned")
    expect(resolveEmployeeDisplayStatus("probation", "locked")).toBe("resigned")
    expect(resolveEmployeeDisplayStatus(null, "locked")).toBe("resigned")
    expect(resolveEmployeeDisplayStatus("unclassified", "locked")).toBe("resigned")
  })

  it("tài khoản còn hoạt động → giữ nguyên employee.status", () => {
    expect(resolveEmployeeDisplayStatus("active", "active")).toBe("active")
    expect(resolveEmployeeDisplayStatus("probation", "active")).toBe("probation")
    expect(resolveEmployeeDisplayStatus("resigned", "active")).toBe("resigned")
    expect(resolveEmployeeDisplayStatus(null, "active")).toBeNull()
  })

  it("không rõ user_status (undefined) → passthrough employee.status (không suy diễn nghỉ việc)", () => {
    expect(resolveEmployeeDisplayStatus("active", undefined)).toBe("active")
    expect(resolveEmployeeDisplayStatus("active", null)).toBe("active")
  })
})
