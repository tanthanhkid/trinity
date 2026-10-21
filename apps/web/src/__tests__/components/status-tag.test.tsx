import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ReconnectNotice, STATUS_LABEL, StatusTag } from "@/components/ui/status-tag"
import { formatCount, formatDateTimeShort, formatNumber, formatVnd } from "@/lib/format"

describe("StatusTag — cùng tình huống, cùng chữ", () => {
  it("chữ chuẩn theo loại; chữ cụ thể hơn khi truyền children", () => {
    const { container } = render(
      <div>
        <StatusTag kind="pending" />
        <StatusTag kind="reauth" size="sm" />
        <StatusTag kind="pending">Chờ Kế toán duyệt</StatusTag>
      </div>,
    )
    expect(screen.getByText("Chờ duyệt")).toBeTruthy()
    expect(screen.getByText("Cần kết nối lại")).toBeTruthy()
    expect(screen.getByText("Chờ Kế toán duyệt")).toBeTruthy()
    expect([...container.querySelectorAll("[data-status]")].map((e) => e.getAttribute("data-status"))).toEqual(["pending", "reauth", "pending"])
    expect(STATUS_LABEL.reauth).toBe("Cần kết nối lại")
  })
})

describe("ReconnectNotice — khoảnh khắc kênh mất kết nối", () => {
  it("nói kênh nào + vì sao + nút Kết nối lại gọi onReconnect", () => {
    const go = vi.fn()
    render(<ReconnectNotice channel="Fanpage AiiLab" reason="Token đã hết hạn." onReconnect={go} />)
    const box = screen.getByTestId("reconnect-notice")
    expect(box.textContent).toContain("Fanpage AiiLab cần kết nối lại")
    expect(box.textContent).toContain("Token đã hết hạn.")
    fireEvent.click(screen.getByRole("button", { name: /Kết nối lại/ }))
    expect(go).toHaveBeenCalledOnce()
  })

  it("không có onReconnect ⇒ link sang màn kết nối", () => {
    render(<ReconnectNotice channel="Zalo OA" href="/connections" />)
    expect(screen.getByRole("link", { name: /Kết nối lại/ })).toHaveAttribute("href", "/connections")
  })
})

describe("số có đơn vị, ngày một kiểu", () => {
  it("formatNumber / formatCount / formatVnd", () => {
    expect(formatNumber(1234567)).toBe("1.234.567")
    expect(formatNumber(null)).toBe("—")
    expect(formatCount(12, "khách")).toBe("12 khách")
    expect(formatVnd(1250000)).toBe("1.250.000 ₫")
    expect(formatVnd(undefined)).toBe("—")
  })

  it("formatDateTimeShort theo giờ VN, không năm", () => {
    expect(formatDateTimeShort("2026-10-21T07:30:00Z")).toBe("14:30 21/10")
    expect(formatDateTimeShort(null)).toBe("—")
  })
})
