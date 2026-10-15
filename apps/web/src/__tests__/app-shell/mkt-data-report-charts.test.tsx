import { describe, expect, it } from "vitest"
import { fireEvent, render } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RecruitmentCharts } from "@/app/(dashboard)/reports/_components/mkt-data-charts"

/* =============================================================================
 * Báo cáo Tuyển dụng — biểu đồ.
 *
 * Áp đủ 3 bài học từ 4 vòng review trước:
 *  · bấm nút "Bảng" TRƯỚC khi đọc (không bấm = chỉ kiểm "biểu đồ có vẽ không");
 *  · đọc ĐÚNG Ô của bảng, không đọc cả trang;
 *  · mọi ca "chưa xác định" phải ra "—", KHÔNG ra 0 / 0%.
 * ========================================================================== */

const REPORTS = join(__dirname, "../../app/(dashboard)/reports/_components")

function openAllTables(container: HTMLElement): string {
  for (const btn of Array.from(container.querySelectorAll("button"))) {
    if (btn.textContent?.trim() === "Bảng") fireEvent.click(btn)
  }
  return container.textContent ?? ""
}

/**
 * Bảng có cột đầu `firstColumn`. `nth` khi có NHIỀU bảng cùng cột đầu — lấy
 * bừa bảng đầu tiên là đọc nhầm số của thẻ khác.
 */
function tableCells(
  container: HTMLElement,
  firstColumn: string,
  nth = 0,
): string[][] {
  const table = Array.from(container.querySelectorAll("table")).filter(
    (t) => t.querySelector("th")?.textContent?.trim() === firstColumn,
  )[nth]
  if (!table) throw new Error(`không tìm thấy bảng #${nth} có cột đầu "${firstColumn}"`)
  return Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
    Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim() ?? ""),
  )
}

describe("🔴 Tuyển dụng — không còn ô số trần", () => {
  it("report-recruitment.tsx: 0 lời gọi <StatCard>/<KpiCard>", () => {
    const src = readFileSync(join(REPORTS, "report-recruitment.tsx"), "utf8")
    expect(src).not.toMatch(/<(?:StatCard|KpiCard)(?![A-Za-z])/)
  })
})

describe("🔴 Tuyển dụng — phễu chỉ gồm chặng LỒNG NHAU", () => {
  const data = {
    positions_posted: 12,
    candidates_interested: 100,
    candidates_interviewed: 40,
    candidates_hired: 8,
    recruitment_messages: null,
    recruitment_messages_available: false,
    cv_received: null,
    cv_received_available: false,
  }

  it("'Số bài đăng' KHÔNG nằm trong phễu — nó là số VỊ TRÍ, không phải ứng viên", () => {
    const { container } = render(<RecruitmentCharts data={data} />)
    openAllTables(container)
    const rows = tableCells(container, "Chặng")
    // 3 chặng phễu có % so chặng đầu; bài đăng và 2 chỉ số phụ đều "—".
    expect(rows.find((r) => r[0] === "Ứng viên quan tâm")?.[2]).toBe("100%")
    expect(rows.find((r) => r[0] === "Số bài đăng tuyển dụng")?.[2]).toBe("—")
  })

  /* `*_available === false` = BE CHƯA CÓ NGUỒN, khác 0 — và cũng khác
   * "—" ở cột bên cạnh, vốn nghĩa "không áp dụng cho dòng này". Dùng CÙNG một
   * glyph cho hai nghĩa là xoá mất phân biệt mà thẻ `NaBadge` cũ có sẵn (nó
   * ghi hẳn chữ "Chưa có dữ liệu"). Test khoá đúng sự phân biệt đó. */
  it("🔴 `*_available === false` nói rõ CHƯA CÓ NGUỒN — không phải 0, cũng không phải '—'", () => {
    const { container } = render(<RecruitmentCharts data={data} />)
    openAllTables(container)
    const rows = tableCells(container, "Chặng")
    for (const label of ["Tin nhắn tuyển dụng", "CV nhận được"]) {
      const cell = rows.find((r) => r[0] === label)?.[1]
      expect(cell).toBe("Chưa có nguồn dữ liệu")
      expect(cell).not.toBe("—")
      expect(cell).not.toBe("0")
    }
    // Dòng KHÔNG ÁP DỤNG vẫn là "—" — hai nghĩa, hai cách viết.
    expect(rows.find((r) => r[0] === "Số bài đăng tuyển dụng")?.[2]).toBe("—")
    // Cái CÓ đo được thì in số thật.
    expect(rows.find((r) => r[0] === "Ứng viên quan tâm")?.[1]).toBe("100")
  })

  it("chưa có ứng viên nào → tỉ lệ '—', KHÔNG phải 0%", () => {
    const { container } = render(
      <RecruitmentCharts
        data={{ ...data, candidates_interested: 0, candidates_hired: 0, candidates_interviewed: 0 }}
      />,
    )
    openAllTables(container)
    expect(
      tableCells(container, "Chỉ số").find((r) => r[0] === "Tỷ lệ nhận việc")?.[1],
    ).toBe("—")
  })
})
