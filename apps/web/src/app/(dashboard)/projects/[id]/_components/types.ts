
export interface Project {
  id: number
  name: string
  code: string
  color: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export const PROJECT_COLOR_MAP: Record<string, string> = {
  blue: 'bg-blue-50 text-blue-600',
  purple: 'bg-purple-50 text-purple-600',
  orange: 'bg-orange-50 text-orange-600',
  green: 'bg-green-50 text-green-600',
  red: 'bg-red-50 text-red-600',
  yellow: 'bg-yellow-50 text-yellow-600',
  pink: 'bg-pink-50 text-pink-600',
  gray: 'bg-gray-50 text-gray-600',
}
