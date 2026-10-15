import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  resolveV2StageBadgeStyle,
  STAGE_BADGE_FALLBACK,
} from "@/lib/contact-stage-badge"

/**
 * Badge "Giai đoạn" ở danh bạ phải phân biệt được màu.
 */
describe("màu badge giai đoạn danh bạ", () => {
  it("3 giai đoạn ra 3 cặp màu KHÁC NHAU", () => {
    const moi = resolveV2StageBadgeStyle("stage", "new")
    const td2 = resolveV2StageBadgeStyle("stage", "follow_up_2")
    const td3 = resolveV2StageBadgeStyle("stage", "follow_up_3")
    const seen = new Set([moi, td2, td3].map((s) => `${s.background}|${s.color}`))
    expect(seen.size).toBe(3)
  })

  it("khoá theo `value` (mã bền), KHÔNG theo nhãn hiển thị", () => {
    // Nhãn admin sửa được ở Cài đặt; nếu map theo nhãn thì đổi nhãn = mất màu.
    expect(resolveV2StageBadgeStyle("stage", "new")).not.toEqual(
      STAGE_BADGE_FALLBACK,
    )
    expect(resolveV2StageBadgeStyle("stage", "Mới")).toEqual(
      STAGE_BADGE_FALLBACK,
    )
  })

  it("🔴 `source='default'` (nhãn “Mới” nhưng stage null) CÙNG màu với 'new'", () => {
    // Không xử riêng thì 2 badge CÙNG chữ "Mới" ra 2 màu khác nhau.
    expect(resolveV2StageBadgeStyle("default", null)).toEqual(
      resolveV2StageBadgeStyle("stage", "new"),
    )
  })

  it("stage không phải giai đoạn danh bạ giữ màu brand, không tô màu giai đoạn", () => {
    // `stage` lúc này là tên bước khác — tô màu "Mới" là sai nghĩa.
    expect(resolveV2StageBadgeStyle("lead_active", "new")).toEqual(STAGE_BADGE_FALLBACK)
    expect(resolveV2StageBadgeStyle("lead_closed", "new")).toEqual(STAGE_BADGE_FALLBACK)
  })

  it("giá trị lạ / thiếu → fallback brand, KHÔNG undefined (badge không mất màu)", () => {
    expect(resolveV2StageBadgeStyle("stage", "giai_doan_moi_toanh")).toEqual(
      STAGE_BADGE_FALLBACK,
    )
    expect(resolveV2StageBadgeStyle(undefined, undefined)).toEqual(STAGE_BADGE_FALLBACK)
  })
})

/**
 * 6 token màu PHẢI nằm trong khối `html:root[data-ui="app"]` — đặt nhầm ra
 * `:root` là đổi màu cho CẢ v1 (làm đổi màu cả giao diện v1).
 */
describe("token badge giai đoạn chỉ sống trong phạm vi v2", () => {
  const css = readFileSync(
    join(__dirname, "../../styles/app-tokens.css"),
    "utf8",
  )
  const v2Block = css.slice(
    css.indexOf('html:root[data-ui="app"]'),
    css.indexOf("\n}", css.indexOf('html:root[data-ui="app"]')),
  )

  it.each([
    ["--color-app-stage-new-bg", "#e3f7ee"],
    ["--color-app-stage-new-ink", "#2f8b1e"],
    ["--color-app-stage-follow2-bg", "#d6fbfa"],
    ["--color-app-stage-follow2-ink", "#2f7170"],
    ["--color-app-stage-follow3-bg", "#fbe8ca"],
    ["--color-app-stage-follow3-ink", "#b86a12"],
  ])("%s = %s (đúng giá trị đã chốt)", (token, hex) => {
    expect(v2Block).toContain(`${token}: ${hex};`)
  })
})
