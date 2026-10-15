import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { ShellRadial } from "@/components/app-shell/charts/radial"
import { ShellBarV } from "@/components/app-shell/charts/bar-v"
import { ShellHeatmap } from "@/components/app-shell/charts/heatmap"
import { ShellArea } from "@/components/app-shell/charts/area"

/* =============================================================================
 * Test RENDER cho 4 primitive biểu đồ mới.
 *
 * 🔴 Vì sao cần file này bên cạnh `chart-primitives.test.ts` (tầng thuần):
 * vòng review đầu tìm ra 4 lỗi mà test tầng thuần KHÔNG bắt được, tất cả cùng
 * một lớp — test tự ghép lại logic thay vì đi qua đúng đường component chạy:
 *
 *   · `formatPercent(NaN)` trả "—" ⇒ test xanh, nhưng component ép giá trị về
 *     0 TRƯỚC khi gọi nên màn hình in "0%".
 *   · Ranh giới chữ trắng của heatmap được "khoá" bằng cách khai lại hằng
 *     trong test + so chuỗi source ⇒ đổi `>=` thành `>` trong component vẫn
 *     xanh, trong khi một bậc tụt xuống 3,41:1.
 *   · aria của cột nhóm đọc TỔNG các series (số không tồn tại ở cột nào) —
 *     hàm thuần `columnTotals` đúng, chỗ GỌI nó mới sai.
 *
 * ⇒ Mọi bất biến phát biểu về THỨ NGƯỜI DÙNG THẤY/NGHE phải test ở đây.
 * ========================================================================== */

describe("🔴 ShellRadial — tỉ lệ CHƯA XÁC ĐỊNH không được in thành 0%", () => {
  it("0/0 (sáng thứ Hai chưa có đơn nào) ra '—', KHÔNG ra '0%'", () => {
    // "0%" nghĩa là có đơn mà không đơn nào hoàn thành — khác hẳn "chưa có dữ liệu".
    // Cùng lớp luật null-vs-0 của dự án.
    const { container } = render(
      <ShellRadial value={(0 / 0) * 100} label="Tỷ lệ hoàn thành" caption="0 / 0 đơn" />,
    )
    expect(container.textContent).toContain("—")
    expect(container.textContent).not.toContain("0%")
  })

  it("0% THẬT (có mẫu số, không đơn nào hoàn thành) vẫn in 0%", () => {
    const { container } = render(
      <ShellRadial value={0} label="Tỷ lệ hoàn thành" caption="0 / 240 đơn" />,
    )
    expect(container.textContent).toContain("0%")
    expect(container.textContent).not.toContain("—")
  })

  it("vượt 100% in SỐ THẬT, cung mới bị kẹp", () => {
    const { container } = render(<ShellRadial value={103.2} label="Hoàn thành" />)
    expect(container.textContent).toContain("103,2%")
  })

  it("số + nhãn + chú thích chỉ được đọc MỘT lần (svg không mang nhãn riêng)", () => {
    const { container } = render(
      <ShellRadial value={52.6} label="Tỷ lệ duyệt" caption="985 / 1.873 đơn" />,
    )
    const svg = container.querySelector("svg")
    expect(svg?.getAttribute("role")).toBe("presentation")
    expect(svg?.getAttribute("aria-label")).toBeNull()
    // Con số chỉ xuất hiện một lần trong cây DOM.
    expect(container.textContent?.match(/52,6%/g)).toHaveLength(1)
  })
})

describe("🔴 ShellBarV — aria của cụm NHÓM không được đọc tổng các series", () => {
  const series = [
    { name: "Doanh số thực đạt", values: [800, 1200] },
    { name: "Mục tiêu", values: [1000, 1000] },
  ]

  it("nhóm: đọc giá trị LỚN NHẤT có thật, không phải 2.200 (= tổng 2 series)", () => {
    render(<ShellBarV categories={["Th 1", "Th 2"]} series={series} />)
    const label = screen.getByRole("img").getAttribute("aria-label") ?? ""
    expect(label).toContain("1.200")
    expect(label).toContain("Doanh số thực đạt")
    expect(label).not.toContain("2.200")
  })

  it("xếp chồng: MỚI được đọc tổng cột (ở đây tổng là số có nghĩa thật)", () => {
    render(<ShellBarV categories={["Th 1", "Th 2"]} series={series} stacked />)
    const label = screen.getByRole("img").getAttribute("aria-label") ?? ""
    expect(label).toContain("2.200")
    expect(label).toContain("tổng")
  })
})

describe("🔴 ShellHeatmap — màu chữ từng ô phải theo đúng ranh giới ĐÃ ĐO", () => {
  it("5 bậc nhạt dùng navy, 2 bậc đậm dùng trắng (đổi >= thành > là đỏ)", () => {
    // Giá trị chọn sao cho rơi đúng vào 7 bậc: ceil(v/70*7)-1 = 0…6
    const values = [10, 20, 30, 40, 50, 60, 70]
    const { container } = render(
      <ShellHeatmap columns={values.map((v) => `c${v}`)} rows={[{ label: "H", values }]} />,
    )
    const cells = Array.from(container.querySelectorAll("tbody td"))
    expect(cells).toHaveLength(7)
    cells.forEach((td, i) => {
      const cls = td.getAttribute("class") ?? ""
      if (i >= 5) {
        expect(cls, `ô bậc ${i} phải chữ TRẮNG`).toContain("text-white")
      } else {
        expect(cls, `ô bậc ${i} phải chữ navy`).toContain("--color-app-navy")
        expect(cls).not.toContain("text-white")
      }
    })
  })

  it("mỗi ô IN SỐ — màu không phải kênh thông tin duy nhất", () => {
    const { container } = render(
      <ShellHeatmap columns={["8g", "9g"]} rows={[{ label: "T2", values: [0, 42] }]} />,
    )
    const cells = Array.from(container.querySelectorAll("tbody td"))
    expect(cells.map((c) => c.textContent)).toEqual(["0", "42"])
  })

  it("dựng bằng <table> thật với scope row/col (trình đọc màn hình đọc được ma trận)", () => {
    const { container } = render(
      <ShellHeatmap
        columns={["8g", "9g"]}
        rows={[{ label: "T2", values: [1, 2] }]}
        rowHeader="Thứ"
      />,
    )
    expect(container.querySelector("table")).not.toBeNull()
    expect(
      container.querySelectorAll('thead th[scope="col"]').length,
    ).toBeGreaterThanOrEqual(2)
    expect(container.querySelector('tbody th[scope="row"]')?.textContent).toBe("T2")
  })
})

describe("ShellArea — ca 1 mốc dữ liệu (lọc ra đúng 1 tháng)", () => {
  it("vẽ chấm bằng nét bo tròn, KHÔNG bằng <circle> (circle bị kéo méo)", () => {
    const { container } = render(
      <ShellArea categories={["Th 3"]} series={[{ name: "Khách mới", values: [7] }]} />,
    )
    expect(container.querySelector("svg circle")).toBeNull()
    const dot = container.querySelector("svg line")
    expect(dot?.getAttribute("stroke-linecap")).toBe("round")
    expect(dot?.getAttribute("vector-effect")).toBe("non-scaling-stroke")
  })

  it("nhãn trục X của mốc duy nhất nằm GIỮA, khớp chỗ vẽ chấm", () => {
    const { container } = render(
      <ShellArea categories={["Th 3"]} series={[{ name: "Hồ sơ", values: [7] }]} />,
    )
    const label = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent === "Th 3",
    )
    expect(label?.getAttribute("style")).toContain("left: 50%")
    expect(container.querySelector("svg line")?.getAttribute("x1")).toBe("50")
  })

  it("aria KHÔNG hardcode 'ngày' — trục có thể là tháng hoặc giờ", () => {
    render(
      <ShellArea
        categories={["Th 1", "Th 2", "Th 3"]}
        series={[{ name: "Khách mới", values: [1, 9, 4] }]}
      />,
    )
    const label = screen.getByRole("img").getAttribute("aria-label") ?? ""
    expect(label).toContain("Th 2")
    expect(label).not.toContain("ngày")
  })
})

describe("cận trên trục chỉ tính phần CÓ NHÃN (series dài hơn categories)", () => {
  it("ShellArea: một giá trị thừa ngoài danh sách nhãn không ép cả đường xuống", () => {
    const draw = (values: number[]) =>
      render(
        <ShellArea categories={["a", "b"]} series={[{ name: "s", values }]} />,
      ).container.textContent
    // Nhãn trục Y phải giống nhau: giá trị thứ 3 không có nhãn X nào để vẽ.
    expect(draw([10, 20])).toBe(draw([10, 20, 9999]))
  })

  it("ShellHeatmap: chú giải không in giá trị không xuất hiện ở ô nào", () => {
    const { container } = render(
      <ShellHeatmap columns={["c1", "c2"]} rows={[{ label: "r", values: [5, 8, 9999] }]} />,
    )
    expect(container.textContent).not.toContain("9.999")
  })
})
