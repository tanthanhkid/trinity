import { fireEvent, render, screen } from "@testing-library/react"
import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"
import { ContactsFilters } from "@/app/(dashboard)/contacts/_components/contacts-filters"
import type { ContactFilters } from "@/hooks/use-contacts"

vi.mock("@/hooks/use-settings-options", () => ({
  useSettingsOptions: () => ({ data: [] }),
}))

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [] }),
}))

vi.mock("@/lib/api-client", () => ({
  default: { get: vi.fn() },
}))

type ContactsFiltersComponentProps = ComponentProps<typeof ContactsFilters>

interface FilterUpdate {
  key: keyof ContactFilters
  value: string
}

function setup(overrides: Partial<ContactsFiltersComponentProps> = {}) {
  const updates: FilterUpdate[] = []
  const onFilterChange = vi.fn((key: keyof ContactFilters) => (value: string) => {
    updates.push({ key, value })
  })
  const props: ContactsFiltersComponentProps = {
    searchInput: "",
    onSearch: vi.fn(),
    onFilterChange,
    onApply: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  }
  const view = render(<ContactsFilters {...props} />)

  return { props, updates, view }
}

function fromDateInput(): HTMLInputElement {
  return screen.getAllByLabelText("Từ ngày")[0] as HTMLInputElement
}

describe("ContactsFilters — date inputs VN text format (DD/MM/YYYY)", () => {
  it("renders ISO prop value as DD/MM/YYYY in the text input", () => {
    setup({ createdFrom: "2026-05-12" })
    expect(fromDateInput()).toHaveValue("12/05/2026")
  })

  it("no aria-invalid khi field rỗng", () => {
    setup()
    expect(fromDateInput()).not.toHaveAttribute("aria-invalid")
  })

  it("no aria-invalid khi đang gõ dở (< 10 ký tự)", () => {
    setup()
    fireEvent.change(fromDateInput(), { target: { value: "10/05" } })
    expect(fromDateInput()).not.toHaveAttribute("aria-invalid")
  })

  it("aria-invalid=true chỉ khi đủ 10 ký tự nhưng invalid (vd 31/02/2026)", () => {
    setup()
    fireEvent.change(fromDateInput(), { target: { value: "31/02/2026" } })
    expect(fromDateInput()).toHaveAttribute("aria-invalid", "true")
  })

  it("emits ISO filter khi gõ đủ ngày hợp lệ DD/MM/YYYY", () => {
    const { updates } = setup()
    fireEvent.change(fromDateInput(), { target: { value: "12/05/2026" } })
    expect(updates).toEqual([{ key: "createdFrom", value: "2026-05-12" }])
  })

  it("clears filter khi xoá text về rỗng", () => {
    const { updates } = setup({ createdFrom: "2026-05-12" })
    fireEvent.change(fromDateInput(), { target: { value: "" } })
    expect(updates).toEqual([{ key: "createdFrom", value: "" }])
  })
})
