"use client"

import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"
import { Input } from "@/components/ui/input"
import apiClient from "@/lib/api-client"

interface DealAssignee {
  id: number
  full_name: string | null
  email: string
}

const MIN_QUERY_LENGTH = 2

const labelOf = (u: DealAssignee) => `${u.full_name ?? u.email} (${u.email})`

/**
 * Chọn người nhận thương vụ khi tạo khách (RBAC quyền + phạm vi): tìm theo tên
 * hoặc email trong phạm vi `deals.manage` của CHÍNH người tạo
 * (`GET /deals/search-sales?q=`, BE kiểm lại khi POST /contacts). Thay cascade
 * DEPT_HEAD → team lead → sale dựng từ `/users?role=…` (so mã vai trò ở FE).
 * Tìm tối thiểu 2 ký tự — dưới ngưỡng BE trả rỗng nên không gọi API.
 */
export function DealAssigneePicker({
  value,
  onChange,
  invalid = false,
}: {
  value: number | undefined
  onChange: (id: number | undefined) => void
  invalid?: boolean
}) {
  const [text, setText] = useState("")
  const [debounced, setDebounced] = useState("")
  const [selected, setSelected] = useState<DealAssignee | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 300)
    return () => clearTimeout(t)
  }, [text])

  const { data: results = [], isFetching } = useQuery<DealAssignee[]>({
    queryKey: ["deals", "search-sales", debounced],
    queryFn: async () => (await apiClient.get<DealAssignee[]>("/deals/search-sales", { params: { q: debounced } })).data,
    enabled: value === undefined && debounced.length >= MIN_QUERY_LENGTH,
    staleTime: 60_000,
  })

  if (value !== undefined) {
    // `selected` chỉ là nhãn của lần chọn gần nhất; cha có thể đặt/xoá `value`
    // (vd chọn Marketing loại trừ) nên chỉ dùng nhãn khi đúng người đang chọn.
    const label = selected?.id === value ? labelOf(selected) : `NV #${value}`
    return (
      <div
        className={`flex min-h-9 items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm ${invalid ? "border-red-500" : ""}`}
      >
        <span className="truncate">{label}</span>
        <button
          type="button"
          aria-label="Bỏ người được gán"
          className="relative rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground max-sm:after:absolute max-sm:after:-inset-3 max-sm:after:content-['']"
          onClick={() => {
            setSelected(null)
            setText("")
            onChange(undefined)
          }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    )
  }

  const searching = debounced.length >= MIN_QUERY_LENGTH
  return (
    <div className="space-y-1">
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Gõ tên hoặc email nhân viên (tối thiểu 2 ký tự)"
        className={invalid ? "border-red-500" : ""}
        autoComplete="off"
      />
      {searching && (
        <ul className="max-h-48 overflow-y-auto rounded-md border bg-card text-sm shadow-sm">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">
              {isFetching ? "Đang tìm..." : "Không tìm thấy nhân viên trong phạm vi của bạn"}
            </li>
          ) : (
            results.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left hover:bg-muted max-sm:min-h-11"
                  onClick={() => {
                    setSelected(u)
                    onChange(u.id)
                  }}
                >
                  {labelOf(u)}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
