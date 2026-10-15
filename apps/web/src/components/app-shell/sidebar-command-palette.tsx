"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { Command } from "cmdk"
import { Moon, Search, Sun, UserPlus, UserRound } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import apiClient from "@/lib/api-client"
import { usePermissions } from "@/lib/rbac"
import { useOrgFeature } from "@/hooks/use-org-features"
import { useTheme } from "@/lib/theme"
import type { FlatMenuEntry } from "@/components/app-shell/menu-resolve"

interface ContactSearchHit {
  id: number
  full_name: string | null
}

function isContactListResponse(body: unknown): body is { data: ContactSearchHit[] } {
  return (
    !!body &&
    typeof body === "object" &&
    Array.isArray((body as { data?: unknown }).data)
  )
}

/** Bỏ dấu để gõ "khach" vẫn ra "Khách hàng". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase()
}

const GROUP_HEADING =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-1 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-sm [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
const ITEM =
  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none select-none data-[selected=true]:bg-accent [&_svg]:size-[18px] [&_svg]:flex-none [&_svg]:text-muted-foreground"

/**
 * Bảng lệnh ⌘K (dựng bằng `cmdk`): tìm khách + nhảy tới các màn trong menu
 * (đã lọc quyền) + vài thao tác (thêm khách, đổi sáng/tối).
 *
 * Tìm khách qua ĐÚNG `GET /contacts` (đã RBAC-scope, cùng endpoint
 * trang `/contacts` dùng) — KHÔNG dùng `GET /contacts/search`: endpoint đó
 * dành cho luồng chống trùng SĐT trước khi tạo khách (không scope theo
 * assigned_to), dùng ở đây sẽ lộ khách ngoài phạm vi của người xem.
 *
 * KHÔNG có lệnh gọi AI phía máy chủ — Trinity không gọi LLM trên server (AI là
 * của người dùng, qua MCP). Không dựng API tìm kiếm toàn cục mới.
 */
export function ShellCommandPalette({
  open,
  onOpenChange,
  navEntries,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  navEntries: FlatMenuEntry[]
}) {
  const router = useRouter()
  const { can } = usePermissions()
  const contactsOn = useOrgFeature("contacts")
  const { theme, setTheme } = useTheme()
  const [query, setQuery] = useState("")

  useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  const trimmed = query.trim()
  const contactSearchEnabled = open && trimmed.length >= 2 && can("contacts.view")
  const { data: contactHits = [] } = useQuery({
    queryKey: ["contacts", "quick-search", trimmed],
    queryFn: async () => {
      const res = await apiClient.get<unknown>("/contacts", {
        params: { search: trimmed, page: 1, limit: 6 },
      })
      if (!isContactListResponse(res.data)) return []
      return res.data.data.slice(0, 6)
    },
    enabled: contactSearchEnabled,
    staleTime: 10_000,
  })

  const q = fold(trimmed)
  const matchedNav = useMemo(() => {
    if (!q) return navEntries.slice(0, 8)
    return navEntries.filter((n) => fold(n.title).includes(q)).slice(0, 8)
  }, [navEntries, q])

  const nextTheme = theme === "dark" ? "light" : "dark"
  const actions = [
    can("contacts.create") && contactsOn
      ? { key: "new-contact", label: "Thêm khách", icon: UserPlus, run: () => goTo("/contacts/new") }
      : null,
    {
      key: "theme",
      label: nextTheme === "dark" ? "Chuyển sang giao diện tối" : "Chuyển sang giao diện sáng",
      icon: nextTheme === "dark" ? Moon : Sun,
      run: () => {
        setTheme(nextTheme)
        onOpenChange(false)
      },
    },
  ].filter((a): a is NonNullable<typeof a> => !!a && (!q || fold(a.label).includes(q)))

  function goTo(href: string) {
    onOpenChange(false)
    router.push(href)
  }

  const nothing = contactHits.length === 0 && matchedNav.length === 0 && actions.length === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[14vh] translate-y-0 gap-0 overflow-hidden rounded-[14px] border border-[color:var(--color-app-line)] p-0 shadow-[0_20px_60px_rgba(0,0,0,0.2)] ring-0 sm:max-w-[600px] max-sm:top-[10vh] max-sm:bottom-auto max-sm:left-1/2 max-sm:w-[calc(100%-2rem)] max-sm:-translate-x-1/2 max-sm:rounded-[14px] max-sm:pb-0"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Tìm hoặc ra lệnh</DialogTitle>
        <Command shouldFilter={false} loop label="Tìm hoặc ra lệnh" className="flex flex-col">
          <div className="flex items-center gap-2.5 border-b border-[color:var(--color-app-line)] px-4 py-3.5">
            <Search className="size-[18px] flex-none text-muted-foreground" aria-hidden />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Tìm khách, màn hình… hoặc ra lệnh"
              className="w-full bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
            />
            <kbd className="flex-none rounded-[5px] border border-[color:var(--color-app-line)] bg-card px-1.5 font-sans text-sm text-muted-foreground">
              Esc
            </kbd>
          </div>
          <Command.List className={`max-h-[min(420px,60vh)] overflow-y-auto p-2 ${GROUP_HEADING}`}>
            {nothing && (
              <p className="px-2.5 py-6 text-center text-sm text-muted-foreground">Không tìm thấy</p>
            )}
            {contactHits.length > 0 && (
              <Command.Group heading="Khách hàng" className="mb-1">
                {contactHits.map((c) => (
                  <Command.Item
                    key={c.id}
                    value={`contact-${c.id}`}
                    onSelect={() => goTo(`/contacts/${c.id}`)}
                    className={ITEM}
                  >
                    <UserRound aria-hidden />
                    <span className="truncate">{c.full_name ?? `Khách #${c.id}`}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {matchedNav.length > 0 && (
              <Command.Group heading="Đi tới" className="mb-1">
                {matchedNav.map((n) => (
                  <Command.Item
                    key={n.key}
                    value={`nav-${n.key}`}
                    onSelect={() => goTo(n.href)}
                    className={ITEM}
                  >
                    <n.icon aria-hidden />
                    <span className="truncate">{n.title}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {actions.length > 0 && (
              <Command.Group heading="Thao tác">
                {actions.map((a) => (
                  <Command.Item key={a.key} value={`action-${a.key}`} onSelect={a.run} className={ITEM}>
                    <a.icon aria-hidden />
                    <span className="truncate">{a.label}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
