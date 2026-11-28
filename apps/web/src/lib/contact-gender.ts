/** Giới tính của khách (cột `contacts.gender`, DTO nhận `nam` | `nu` | `khac`). Thứ tự theo thiết kế khach-mobile2. */
export const CONTACT_GENDERS = [
  { value: "nu", label: "Nữ" },
  { value: "nam", label: "Nam" },
  { value: "khac", label: "Khác" },
] as const

/** Nhãn hiển thị của giới tính; giá trị lạ/trống ⇒ `null`. */
export function genderLabel(value: string | null | undefined): string | null {
  return CONTACT_GENDERS.find((g) => g.value === value)?.label ?? null
}
