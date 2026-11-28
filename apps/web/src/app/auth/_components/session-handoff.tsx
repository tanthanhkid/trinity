"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Loader2 } from "lucide-react"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { redeemEmailLink, redeemLoginTicket, type LoginResult } from "@/lib/auth-api"
import { resetLogoutState } from "@/lib/api-client"
import { serverSentence } from "@/lib/error-messages"
import { safeNextPath } from "@/lib/oauth-authorize"
import { clearTokens, setAccessToken, setRefreshToken } from "@/lib/token-storage"
import { useAuthStore } from "@/store/auth"
import { useAppDocumentTheme } from "@/hooks/use-app-shell"
import { appFont } from "@/lib/app-font"
import { LoginBrandPanel } from "../../login/_components/login-brand-panel"

/**
 * Trang trung gian nhận phiên (#675): đọc bí mật trong fragment (`#token=…` của link email, `#ticket=…` sau Google) — phần
 * sau `#` không bao giờ tới máy chủ, không vào log hay `Referer` — đổi lấy phiên bằng một lời gọi POST rồi vào app.
 * Xoá fragment khỏi thanh địa chỉ ngay khi đọc để bí mật không nằm lại trong lịch sử trình duyệt.
 */
export function SessionHandoff({ kind }: { kind: "email" | "ticket" }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const setAuth = useAuthStore((s) => s.setAuth)
  const clearAuth = useAuthStore((s) => s.clearAuth)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  useAppDocumentTheme(appFont.variable)

  useEffect(() => {
    if (started.current) return
    started.current = true
    const frag = new URLSearchParams(window.location.hash.replace(/^#/, ""))
    const secret = frag.get(kind === "email" ? "token" : "ticket")
    const next = safeNextPath(frag.get("next"))
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search)
    if (!secret) {
      queueMicrotask(() => setError("Link đăng nhập không đầy đủ. Hãy mở lại link trong thư hoặc nhập mã 6 số."))
      return
    }
    const redeem: Promise<LoginResult> = kind === "email" ? redeemEmailLink(secret) : redeemLoginTicket(secret)
    redeem
      .then((res) => {
        resetLogoutState()
        queryClient.clear()
        clearTokens()
        clearAuth()
        setAccessToken(res.tokens.accessToken)
        setRefreshToken(res.tokens.refreshToken)
        setAuth({ user: res.user, roles: res.roles, permissions: res.permissions, isAdmin: res.isAdmin, company: res.company }, res.tokens)
        router.replace(next ?? "/dashboard")
      })
      .catch((err: unknown) => {
        setError(
          serverSentence(err) ??
            (kind === "email"
              ? "Link đăng nhập không hợp lệ, đã dùng hoặc đã hết hạn. Hãy gửi lại mã mới."
              : "Phiên đăng nhập đã hết hạn, hãy đăng nhập lại."),
        )
      })
  }, [kind]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <LoginBrandPanel />
      <div className="relative flex items-center justify-center bg-background p-6 max-sm:items-start max-sm:pt-[12dvh] sm:p-10">
        <div className="relative w-full max-w-sm space-y-6">
          {error ? (
            <>
              <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Chưa đăng nhập được</h1>
              <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive px-4 py-3 text-sm text-white">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
              <Link href="/login" className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">
                Về trang đăng nhập
              </Link>
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Đang đăng nhập...
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
