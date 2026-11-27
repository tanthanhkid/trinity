"use client"

import { useCallback, useEffect, useState } from "react"

const KEY_PREFIX = "trinity.sidebar.collapsed-groups"

function read(storageKey: string): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []
  } catch {
    return []
  }
}

/**
 * Nhóm sidebar nào đang thu gọn — nhớ theo người dùng (localStorage, khoá kèm id người dùng).
 * Mặc định mở hết; localStorage hỏng/bị chặn thì vẫn chạy (chỉ không nhớ).
 */
export function useNavGroupCollapse(userId: string | number | null | undefined) {
  const storageKey = `${KEY_PREFIX}:${userId ?? "anon"}`
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    setCollapsed(new Set(read(storageKey)))
  }, [storageKey])

  const toggle = useCallback(
    (key: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        try {
          window.localStorage.setItem(storageKey, JSON.stringify([...next]))
        } catch {
          /* không lưu được thì thôi */
        }
        return next
      })
    },
    [storageKey],
  )

  return { isCollapsed: (key: string) => collapsed.has(key), toggle }
}
