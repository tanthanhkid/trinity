/**
 * Render test cho bộ primitive v2 dùng chung. Mỗi primitive chỉ cần render đúng nội dung truyền
 * vào + đúng trạng thái rỗng (nếu có) — KHÔNG test màu sắc bằng snapshot (đo
 * contrast là việc của `contrast.test.ts`/`stat-card-contrast.test.ts`,
 * đo bằng công thức WCAG trên giá trị hex, không phải bằng cách render DOM).
 */
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { CalendarDays } from "lucide-react"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { ShellStatCard, ShellStatGrid } from "@/components/app-shell/stat-card"
import { ShellFilterBar, ShellFilterField } from "@/components/app-shell/filter-bar"
import { ShellTableFrame } from "@/components/app-shell/table-frame"
import { ShellEmptyState } from "@/components/app-shell/empty-state"
import { ShellTabs, ShellTabsList, ShellTabsTrigger, ShellTabsContent } from "@/components/app-shell/tabs"

describe("ShellPageHeader", () => {
  it("render tiêu đề + mô tả + action", () => {
    render(
      <ShellPageHeader
        title="Chấm công"
        description="Mô tả ngắn"
        actions={<button>Xuất Excel</button>}
      />,
    )
    expect(screen.getByRole("heading", { name: "Chấm công" })).toBeInTheDocument()
    expect(screen.getByText("Mô tả ngắn")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Xuất Excel" })).toBeInTheDocument()
  })

  it("giao diện mới: không vẽ ô icon ở đầu trang dù có truyền icon", () => {
    const { container } = render(<ShellPageHeader title="X" icon={CalendarDays} />)
    expect(container.querySelector("svg")).not.toBeInTheDocument()
  })

  it("không có description/actions → KHÔNG render node rỗng", () => {
    render(<ShellPageHeader title="Chỉ tiêu đề" />)
    expect(screen.getByRole("heading", { name: "Chỉ tiêu đề" })).toBeInTheDocument()
  })
})

describe("ShellStatCard / ShellStatGrid", () => {
  it("render label + value + hint", () => {
    render(
      <ShellStatCard icon={CalendarDays} tone="primary" label="Tổng NV" value="128" hint="+3 tuần này" />,
    )
    expect(screen.getByText("Tổng NV")).toBeInTheDocument()
    expect(screen.getByText("128")).toBeInTheDocument()
    expect(screen.getByText("+3 tuần này")).toBeInTheDocument()
  })

  it.each(["primary", "blue", "green", "amber", "red", "violet", "pink"] as const)(
    "tone=%s render được không lỗi",
    (tone) => {
      render(<ShellStatCard icon={CalendarDays} tone={tone} label="L" value="1" />)
      expect(screen.getByText("L")).toBeInTheDocument()
    },
  )

  it("ShellStatGrid render đủ số con", () => {
    render(
      <ShellStatGrid>
        <ShellStatCard icon={CalendarDays} label="A" value="1" />
        <ShellStatCard icon={CalendarDays} label="B" value="2" />
      </ShellStatGrid>,
    )
    expect(screen.getByText("A")).toBeInTheDocument()
    expect(screen.getByText("B")).toBeInTheDocument()
  })
})

describe("ShellFilterBar / ShellFilterField", () => {
  it("render field con + actions", () => {
    render(
      <ShellFilterBar actions={<button>Tìm kiếm</button>}>
        <ShellFilterField label="Trạng thái">
          <select aria-label="Trạng thái" />
        </ShellFilterField>
      </ShellFilterBar>,
    )
    expect(screen.getByText("Trạng thái")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Tìm kiếm" })).toBeInTheDocument()
  })
})

describe("ShellTableFrame", () => {
  it("render title + toolbar + nội dung", () => {
    render(
      <ShellTableFrame title="Danh sách" toolbar={<button>Lọc</button>}>
        <table>
          <tbody>
            <tr>
              <td>Dòng 1</td>
            </tr>
          </tbody>
        </table>
      </ShellTableFrame>,
    )
    expect(screen.getByText("Danh sách")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Lọc" })).toBeInTheDocument()
    expect(screen.getByText("Dòng 1")).toBeInTheDocument()
  })

  it("không truyền title/toolbar → vẫn render nội dung, không vỡ", () => {
    render(
      <ShellTableFrame>
        <p>Nội dung trần</p>
      </ShellTableFrame>,
    )
    expect(screen.getByText("Nội dung trần")).toBeInTheDocument()
  })
})

describe("ShellEmptyState — trạng thái rỗng", () => {
  it("render icon + tiêu đề + mô tả + action", () => {
    render(
      <ShellEmptyState
        icon={CalendarDays}
        title="Chưa có dữ liệu"
        description="Thử đổi bộ lọc"
        action={<button>Đặt lại</button>}
      />,
    )
    expect(screen.getByText("Chưa có dữ liệu")).toBeInTheDocument()
    expect(screen.getByText("Thử đổi bộ lọc")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Đặt lại" })).toBeInTheDocument()
  })

  it("chỉ bắt buộc icon — title/description/action đều optional", () => {
    const { container } = render(<ShellEmptyState icon={CalendarDays} />)
    expect(container.querySelector("svg")).toBeInTheDocument()
  })
})

describe("ShellTabs — khung tab", () => {
  it("chuyển tab hiện đúng nội dung panel", () => {
    render(
      <ShellTabs defaultValue="a">
        <ShellTabsList>
          <ShellTabsTrigger value="a">Tab A</ShellTabsTrigger>
          <ShellTabsTrigger value="b">Tab B</ShellTabsTrigger>
        </ShellTabsList>
        <ShellTabsContent value="a">Nội dung A</ShellTabsContent>
        <ShellTabsContent value="b">Nội dung B</ShellTabsContent>
      </ShellTabs>,
    )
    expect(screen.getByText("Nội dung A")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Tab A" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Tab B" })).toBeInTheDocument()
  })
})
