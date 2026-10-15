import { z } from 'zod'

// ---------------------------------------------------------------------------
// Types & Constants — shared by /projects page + Settings projects
// ---------------------------------------------------------------------------

export interface Project {
  id: number
  name: string
  code: string
  color: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export const COLOR_OPTIONS = [
  { value: 'blue', label: 'Xanh dương', class: 'bg-blue-50 text-blue-600' },
  { value: 'purple', label: 'Tím', class: 'bg-purple-50 text-purple-600' },
  { value: 'orange', label: 'Cam', class: 'bg-orange-50 text-orange-600' },
  { value: 'green', label: 'Xanh lá', class: 'bg-green-50 text-green-600' },
  { value: 'red', label: 'Đỏ', class: 'bg-red-50 text-red-600' },
  { value: 'yellow', label: 'Vàng', class: 'bg-yellow-50 text-yellow-600' },
  { value: 'pink', label: 'Hồng', class: 'bg-pink-50 text-pink-600' },
  { value: 'gray', label: 'Xám', class: 'bg-gray-50 text-gray-600' },
]
export const COLOR_MAP: Record<string, string> = Object.fromEntries(
  COLOR_OPTIONS.map((c) => [c.value, c.class]),
)
export const COLOR_LABEL: Record<string, string> = Object.fromEntries(
  COLOR_OPTIONS.map((c) => [c.value, c.label]),
)

export const projectFormSchema = z.object({
  name: z.string().min(2, 'Tên dự án tối thiểu 2 ký tự').max(255),
  code: z
    .string()
    .min(2, 'Mã dự án tối thiểu 2 ký tự')
    .max(100)
    .regex(/^[a-z0-9_]+$/, 'Mã chỉ chứa chữ thường, số và gạch dưới')
    .or(z.literal('')),
  color: z.string().optional(),
})

export type ProjectForm = z.infer<typeof projectFormSchema>
