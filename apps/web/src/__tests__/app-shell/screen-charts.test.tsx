import { describe, expect, it } from "vitest"
import { fireEvent, render } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ShellShareCard,
  ShellCompareCard,
  ShellRateCard,
  ShellFunnelCard,
} from "@/components/app-shell/charts/screen-charts"

/**
 * "Không được có 0% ở đâu trên thẻ" — dùng cho mọi ca CHƯA XÁC ĐỊNH.
 *
 * 🔴 KHÔNG dùng `/\b0(0)?%/`. `textContent` NỐI LIỀN chữ của các phần tử cạnh
 * nhau, nên số của vòng tỉ lệ dính ngay sau nhãn nút: `"…Bảng0%Hoàn thành…"`. Ký
 * tự trước số `0` khi đó là `g` — một ký tự TỪ — nên `\b` không có ranh giới
 * nào để khớp và assertion IM LẶNG luôn đúng. Đo thật: gỡ guard `NaN` của vòng
 * đi, vòng in "0%", mà 27/27 test vẫn xanh.
 *
 * Thay bằng "đầu chuỗi hoặc một ký tự KHÔNG PHẢI chữ số/dấu phẩy" — vẫn bắt
 * "Bảng0%" và vẫn không bắt oan "50%" / "100%" / "30–50%".
 */
const NO_ZERO_PERCENT = /(^|[^\d,])0(,0)?%/


/* =============================================================================
 * Các màn NGOÀI Trung tâm báo cáo.
 *
 * 4 primitive ở đây mã hoá một QUYẾT ĐỊNH về dữ liệu, không phải kiểu vẽ:
 *   · `ShellShareCard`   — các phần cộng lại thành MỘT tổng (vành khuyên = 100%)
 *   · `ShellCompareCard` — cùng đơn vị nhưng KHÔNG phải phần của tổng
 *   · `ShellRateCard`    — một tỉ lệ, luôn kèm 2 số gốc sinh ra nó
 *   · `ShellFunnelCard`  — các chặng LỒNG NHAU
 * Chọn nhầm primitive là nói sai về dữ liệu, nên test khoá đúng chỗ đó.
 * ========================================================================== */

const DASHBOARD_ROOT = join(__dirname, "../../app/(dashboard)")

function openAllTables(container: HTMLElement): string {
  for (const btn of Array.from(container.querySelectorAll("button"))) {
    if (btn.textContent?.trim() === "Bảng") fireEvent.click(btn)
  }
  return container.textContent ?? ""
}

function tableCells(container: HTMLElement, firstColumn: string, nth = 0): string[][] {
  const table = Array.from(container.querySelectorAll("table")).filter(
    (t) => t.querySelector("th")?.textContent?.trim() === firstColumn,
  )[nth]
  if (!table) throw new Error(`không tìm thấy bảng #${nth} có cột đầu "${firstColumn}"`)
  return Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
    Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim() ?? ""),
  )
}

describe("🔴 màn ngoài Trung tâm báo cáo", () => {
  it("🔴 2 ô số ĐƯỢC GIỮ phải kèm lý do viết ra — không im lặng bỏ sót", () => {
    // Nguyên tắc chung: số đếm đơn lẻ không có chiều nào để vẽ thì GIỮ,
    // nhưng phải nói rõ vì sao. Không có lời giải thích thì lần sau không ai
    // phân biệt được "cố ý giữ" với "làm sót".
    const payroll = readFileSync(join(DASHBOARD_ROOT, "payroll/_components/payroll-reports.tsx"), "utf8")
    expect(payroll).toMatch(/[Dd]ạng thẻ số/)
    // Lý do phải nói tới việc BE chỉ trả 2 mốc — đó là căn cứ kiểm được.
    expect(payroll).toMatch(/2 mốc|hai mốc/)
  })
})

describe("🔴 ShellShareCard — các phần PHẢI cộng thành tổng", () => {
  it("chênh lệch với `total` hiện thành lát 'Khác', không im lặng bỏ qua", () => {
    const { container } = render(
      <ShellShareCard
        title="Kho"
        parts={[{ label: "A", value: 30 }, { label: "B", value: 20 }]}
        total={100}
        unit="số"
      />,
    )
    openAllTables(container)
    const rows = tableCells(container, "Hạng mục")
    expect(rows.find((r) => r[0] === "Khác")?.[1]).toBe("50")
    expect(rows.find((r) => r[0] === "Tổng")?.[1]).toBe("100")
  })

  it("khớp tổng thì KHÔNG đẻ lát 'Khác' rỗng", () => {
    const { container } = render(
      <ShellShareCard
        title="Kho"
        parts={[{ label: "A", value: 60 }, { label: "B", value: 40 }]}
        total={100}
      />,
    )
    openAllTables(container)
    expect(tableCells(container, "Hạng mục").map((r) => r[0])).not.toContain("Khác")
  })

  it("mọi phần bằng 0 → nói rõ chưa có dữ liệu, KHÔNG vẽ vành khuyên rỗng", () => {
    const { container } = render(
      <ShellShareCard
        title="Kho"
        parts={[{ label: "A", value: 0 }]}
        emptyText="Kho đang trống"
      />,
    )
    expect(container.textContent).toContain("Kho đang trống")
  })
})

describe("🔴 ShellRateCard — mẫu số 0 là CHƯA XÁC ĐỊNH, không phải 0%", () => {
  it("mẫu số 0 → '—' ở cả bảng lẫn vòng", () => {
    const { container } = render(
      <ShellRateCard
        title="Tỉ lệ"
        label="Đã xong"
        numerator={0}
        denominator={0}
        unitText="việc"
      />,
    )
    // Caption đọc TRƯỚC khi bấm Bảng (bấm xong thì biểu đồ bị ẩn).
    expect(container.textContent).toContain("Chưa có việc nào")
    expect(container.textContent).not.toMatch(NO_ZERO_PERCENT)
    openAllTables(container)
    expect(tableCells(container, "Chỉ số").find((r) => r[0] === "Tỉ lệ")?.[1]).toBe("—")
  })

  it("🔴 luôn kèm 2 SỐ GỐC — 55% của 20 khác hẳn 55% của 20.000", () => {
    const { container } = render(
      <ShellRateCard
        title="Tỉ lệ"
        label="Hoàn thành"
        numerator={5786}
        denominator={10520}
        unitText="đơn"
      />,
    )
    expect(container.textContent).toContain("5.786 / 10.520 đơn")
  })

  it("0% THẬT (có mẫu số, tử số 0) vẫn in 0%", () => {
    const { container } = render(
      <ShellRateCard title="Tỉ lệ" label="Đã xong" numerator={0} denominator={240} unitText="việc" />,
    )
    openAllTables(container)
    expect(tableCells(container, "Chỉ số").find((r) => r[0] === "Tỉ lệ")?.[1]).toBe("0%")
  })
})

describe("ShellFunnelCard — chặng lồng nhau", () => {
  it("% tính trên CHẶNG ĐẦU, dòng phụ để '—' (khác đơn vị)", () => {
    const { container } = render(
      <ShellFunnelCard
        title="Phễu"
        unitText="Số"
        steps={[
          { label: "Đã tạo", value: 100 },
          { label: "Đã chốt", value: 40 },
        ]}
        extraRows={[["Doanh số", "9 tr"]]}
      />,
    )
    openAllTables(container)
    const rows = tableCells(container, "Chặng")
    expect(rows.find((r) => r[0] === "Đã chốt")?.[2]).toBe("40%")
    expect(rows.find((r) => r[0] === "Doanh số")?.[2]).toBe("—")
  })

  it("🔴 chặng đầu bằng 0 nhưng chặng sau CÓ SỐ → '—', không phải Infinity%", () => {
    // Ca trước cho cả 2 chặng = 0: `0/0` ra `NaN` và `formatPercent(NaN)` cũng
    // trả "—", nên đột biến bỏ guard `first > 0` vẫn xanh một cách tình cờ.
    // Dữ liệu thật có ca này: bước đầu đã trôi hết bản ghi đi trong khi bước sau
    // còn giữ — `40/0` ra Infinity, in ra "Infinity%".
    const { container } = render(
      <ShellFunnelCard
        title="Phễu"
        unitText="Số"
        steps={[{ label: "A", value: 0 }, { label: "B", value: 40 }]}
        emptyText="Chưa có gì"
      />,
    )
    openAllTables(container)
    const text = container.textContent ?? ""
    expect(text).not.toContain("NaN")
    expect(text).not.toContain("Infinity")
    expect(tableCells(container, "Chặng").map((r) => r[2])).toEqual(["—", "—"])
  })
})

describe("ShellCompareCard — cùng đơn vị nhưng KHÔNG phải phần của tổng", () => {
  it("KHÔNG in dòng 'Tổng' (các số này không cộng lại được)", () => {
    const { container } = render(
      <ShellCompareCard
        title="So sánh"
        items={[
          { label: "Tổng đang quản lý", value: 50 },
          { label: "Đang chạy", value: 30 },
        ]}
      />,
    )
    openAllTables(container)
    expect(tableCells(container, "Chỉ số").map((r) => r[0])).not.toContain("Tổng")
  })
})

/* =============================================================================
 * HỒI QUY — 3 lỗi nặng + 3 lỗi vừa.
 *
 * Bài học chung của cả vòng: SAI KHÔNG NẰM Ở CÁCH VẼ mà ở việc khẳng định một
 * quan hệ dữ liệu KHÔNG CÓ THẬT (lồng nhau / cộng thành tổng / chia được cho
 * nhau). Vì vậy test dưới đây neo vào NGUỒN SỐ ở BE, không neo vào pixel.
 * ========================================================================== */

describe("🔴 nhánh LỖI không được in trạng-thái-rỗng", () => {
  it.each([
    ["management/recruitment/page.tsx", /pageStatsError/],
  ])("%s có nhánh lỗi riêng", (file, re) => {
    expect(readFileSync(join(DASHBOARD_ROOT, file), "utf8")).toMatch(re)
  })
})

describe("🔴 quá 4 phần thì KHÔNG dùng vành khuyên", () => {
  const parts6 = [
    { label: "18-25", value: 10 },
    { label: "26-35", value: 20 },
    { label: "36-45", value: 30 },
    { label: "46-55", value: 15 },
    { label: "56-65", value: 8 },
    { label: "> 65", value: 5 },
  ]

  /* Luật của chính bộ kit: WARN CVD ở cặp màu thứ 5–6, chỉ chạm khi vẽ quá 4
   * series. Dải tuổi là thang THỨ TỰ nên không gộp "Khác" được; dải teal tuần
   * tự cũng không cứu (từ bậc 4 `#42b8ac` 2,42 đã dưới 3:1). ⇒ thanh một sắc. */
  it("6 dải tuổi ra THANH (một sắc), không ra vành khuyên", () => {
    const { container } = render(
      <ShellShareCard title="Khách theo dải tuổi" parts={parts6} total={88} unit="khách" />,
    )
    expect(container.querySelector("svg circle")).toBeNull()
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0)
  })

  it("≤ 4 phần vẫn giữ vành khuyên", () => {
    const { container } = render(
      <ShellShareCard title="x" parts={parts6.slice(0, 4)} total={75} unit="khách" />,
    )
    expect(container.querySelector("svg circle")).not.toBeNull()
  })

  it("đổi kiểu vẽ KHÔNG làm mất cột 'Tỉ lệ' — vẫn là phần của một tổng", () => {
    const { container } = render(
      <ShellShareCard title="x" parts={parts6} total={88} unit="khách" />,
    )
    openAllTables(container)
    const rows = tableCells(container, "Hạng mục")
    expect(rows.find((r) => r[0] === "18-25")?.[2]).toMatch(/%$/)
    expect(rows.at(-1)?.[0]).toBe("Tổng")
  })
})

describe("🔴 3 ca biên primitive từng nuốt im lặng", () => {
  /* Ca THẬT: chặng đầu trôi hết về 0 trong khi chặng sau còn 40.
   * `first === 0` mà in "chưa có dữ liệu" là GIẤU 40 bản ghi có thật. */
  it("phễu: chặng đầu 0 nhưng chặng sau CÓ SỐ vẫn vẽ hình", () => {
    const { container } = render(
      <ShellFunnelCard
        title="x"
        unitText="Số"
        steps={[
          { label: "Đã tạo", value: 0 },
          { label: "Đã chốt", value: 40 },
        ]}
        emptyText="KHÔNG-ĐƯỢC-HIỆN"
      />,
    )
    expect(container.textContent).not.toContain("KHÔNG-ĐƯỢC-HIỆN")
  })

  it("phễu: MỌI chặng bằng 0 thì mới báo chưa có dữ liệu", () => {
    const { container } = render(
      <ShellFunnelCard
        title="x"
        unitText="Số"
        steps={[
          { label: "a", value: 0 },
          { label: "b", value: 0 },
        ]}
        emptyText="CHƯA-CÓ"
      />,
    )
    expect(container.textContent).toContain("CHƯA-CÓ")
  })

  /* `total` ước lượng (`reltuples`) có thể NHỎ HƠN tổng các lát. Im lặng thì
   * dòng "Tổng" in số nhỏ hơn tổng các cột mà vẫn ghi "100%". */
  it("share: tổng các phần LỚN HƠN `total` thì nói ra, không im lặng", () => {
    const { container } = render(
      <ShellShareCard
        title="x"
        parts={[
          { label: "a", value: 60 },
          { label: "b", value: 50 },
        ]}
        total={100}
        unit="số"
      />,
    )
    openAllTables(container)
    const rows = tableCells(container, "Hạng mục")
    expect(rows.find((r) => r[0] === "Tổng các phần")?.[1]).toBe("110")
    expect(rows.find((r) => r[0] === "Tổng đối chiếu")?.[1]).toBe("100")
  })

  /* Tử > mẫu ⇒ `ShellRadial` kẹp cung ở 100% nhưng số in ra vẫn "250%": hình và
   * số nói hai chuyện khác nhau. Thường là dấu hiệu mẫu số không phải quần thể
   * của tử. */
  it("rate: tử LỚN HƠN mẫu thì cảnh báo cung bị kẹp", () => {
    const { container } = render(
      <ShellRateCard
        title="x"
        label="Đã hoàn tất"
        numerator={250}
        denominator={100}
        unitText="đồng doanh số"
      />,
    )
    openAllTables(container)
    const rows = tableCells(container, "Chỉ số")
    expect(rows.find((r) => r[0] === "⚠ Lưu ý")?.[1]).toContain("kẹp ở 100%")
  })

  it("rate: tử ≤ mẫu thì KHÔNG có dòng cảnh báo thừa", () => {
    const { container } = render(
      <ShellRateCard title="x" label="y" numerator={30} denominator={100} unitText="z" />,
    )
    openAllTables(container)
    expect(tableCells(container, "Chỉ số").some((r) => r[0] === "⚠ Lưu ý")).toBe(false)
  })
})

describe("🔴 2 chỗ còn sót", () => {
  /* 3 ô số trần nằm trong HỘP THOẠI nên lọt qua test grep `<StatCard>`. */
  it("tuyển dụng: hộp thoại Thống kê không còn 3 ô số trần", () => {
    const src = readFileSync(join(DASHBOARD_ROOT, "management/recruitment/page.tsx"), "utf8")
    expect(src).not.toMatch(/<p className="text-2xl font-bold">\{stats\.total\}<\/p>/)
    expect(src).not.toMatch(/Chi phí tổng<\/p>/)
  })
})
