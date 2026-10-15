'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'
import { EMPTY_FILTER, type DashboardFilterValue } from './dashboard-filter-utils'
import { useCanUseDashboardFilter } from './use-dashboard-overview'

/**
 * Bộ lọc phạm vi (Phòng/Team/NV) dùng CHUNG cho thẻ số đầu trang và khối "Số liệu kinh doanh" phía dưới —
 * cùng một giá trị ⇒ cùng queryKey ⇒ React Query chỉ gọi BE một lần. Role không có quyền lọc LUÔN nhận bộ lọc rỗng
 * (BE cũng bỏ qua tham số lọc).
 */
interface Ctx {
  filter: DashboardFilterValue
  effective: DashboardFilterValue
  setFilter: (f: DashboardFilterValue) => void
}

const FilterCtx = createContext<Ctx>({ filter: EMPTY_FILTER, effective: EMPTY_FILTER, setFilter: () => {} })

export function DashboardFilterProvider({ children }: { children: ReactNode }) {
  const canFilter = useCanUseDashboardFilter()
  const [filter, setFilter] = useState<DashboardFilterValue>(EMPTY_FILTER)
  return (
    <FilterCtx.Provider value={{ filter, effective: canFilter ? filter : EMPTY_FILTER, setFilter }}>
      {children}
    </FilterCtx.Provider>
  )
}

export const useDashboardFilter = () => useContext(FilterCtx)
