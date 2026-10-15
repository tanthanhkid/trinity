import { describe, expect, it } from "vitest"
import { describePermissions } from "@/lib/extensions"
import type { ExtensionManifest } from "@/lib/extensions"

const base = { net: [], tables: { read: [], write: [] } } as unknown as ExtensionManifest

describe("describePermissions — giới hạn", () => {
  it("chỉ có timeoutMs: câu vẫn đủ nghĩa, không còn 'mặc định MB'", () => {
    const lines = describePermissions({ ...base, limits: { timeoutMs: 5000 } } as ExtensionManifest, "job")
    const l = lines.find((x) => x.startsWith("Giới hạn"))!
    expect(l).toContain("5 giây")
    expect(l).toContain("bộ nhớ mặc định")
    expect(l).not.toContain("mặc định MB")
  })

  it("chỉ có memoryMb", () => {
    const lines = describePermissions({ ...base, limits: { memoryMb: 64 } } as ExtensionManifest, "job")
    expect(lines.find((x) => x.startsWith("Giới hạn"))).toContain("64 MB bộ nhớ")
  })
})
