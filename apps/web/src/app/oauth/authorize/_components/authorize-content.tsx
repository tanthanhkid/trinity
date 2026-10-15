"use client"

import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { useMutation, useQuery } from "@tanstack/react-query"
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react"
import apiClient from "@/lib/api-client"
import { appFont } from "@/lib/app-font"
import { readAuthorizeParams, safeExternalRedirect, type AuthorizeParams } from "@/lib/oauth-authorize"
import { useAppDocumentTheme } from "@/hooks/use-app-shell"
import { useAuthStore } from "@/store/auth"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent } from "@/components/ui/card"
import { MobileActionBar } from "@/components/app-shell/mobile-action-bar"
import { ConsentClient, type ConsentClientInfo } from "./consent-client"

interface ConsentScope {
  scope: string
  label: string
  description: string
  available: boolean
  /** Scope tuỳ chọn (crm.write — AI thay đổi dữ liệu trực tiếp trong phạm vi quyền của người dùng): mặc định TICK SẴN, người dùng bỏ được. */
  optional?: boolean
}

type ContextResponse =
  | { ok: true; client: ConsentClientInfo; scopes: ConsentScope[]; consent_token: string; expires_in: number }
  | { ok: false; redirect_to: string }

/** Thông điệp THẬT của BE: OAuth trả `error_description`, Nest trả `message`. */
function errorText(err: unknown): { status: number | null; text: string } {
  const r = (err as { response?: { status?: number; data?: { error_description?: string; message?: string | string[] } } })?.response
  const status = r?.status ?? null
  const msg = r?.data?.error_description ?? (Array.isArray(r?.data?.message) ? r?.data?.message.join("; ") : r?.data?.message)
  if (status === 403) return { status, text: "Tài khoản của bạn chưa được cấp quyền nối tài khoản vào ChatGPT/Claude (integrations.ai_connect). Hãy liên hệ quản trị viên." }
  if (status === 404) return { status, text: "Tính năng Kết nối AI chưa được bật trên hệ thống này." }
  if (status === 429) return { status, text: "Bạn thao tác quá nhanh. Vui lòng đợi một chút rồi tải lại trang." }
  return { status, text: msg || "Không kiểm tra được yêu cầu kết nối. Vui lòng thử lại." }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-4 px-4 py-8">
      <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
        <ShieldCheck className="size-5 text-primary" /> Trinity CRM
      </div>
      {children}
    </div>
  )
}

function ErrorCard({ text }: { text: string }) {
  return (
    <Shell>
      <Card>
        <CardContent className="flex items-start gap-2 py-5 text-sm text-red-700" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{text}</span>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">Bạn chưa cấp quyền gì. Đóng trang này và bắt đầu lại kết nối từ ChatGPT/Claude.</p>
    </Shell>
  )
}

/**
 * Màn đồng ý. Mọi tham số đi nguyên văn lên BE kiểm lại; FE chỉ HIỂN THỊ kết quả kiểm + gửi quyết định kèm
 * `consent_token`. Lỗi client/redirect_uri (BE trả 400) hiện ngay trên trang — KHÔNG điều hướng (chống open redirect).
 */
export function AuthorizeContent() {
  useAppDocumentTheme(appFont.variable)
  const search = useSearchParams()
  const params: AuthorizeParams = useMemo(() => readAuthorizeParams(search), [search])
  const email = useAuthStore((s) => s.user?.email)
  const paramsKey = JSON.stringify(params)
  // Quyền tuỳ chọn (thay đổi dữ liệu) mặc định BẬT (không tick ⇒ AI chỉ đọc, mọi tool ghi bị từ chối) —
  // chỉ cấp khi client xin; người dùng bỏ tick được. Thay đổi có hiệu lực ngay theo quyền của người dùng (trừ khi quản trị bật chế độ duyệt).
  const [optionalOff, setOptionalOff] = useState<Record<string, boolean>>({})

  const ctx = useQuery<ContextResponse>({
    queryKey: ["oauth-authorize-context", paramsKey],
    // consent_token dùng một lần/10 phút — không tự làm mới, không giữ cache sau khi rời trang.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => (await apiClient.post<ContextResponse>("/oauth/authorize/context", { params })).data,
  })

  const decide = useMutation({
    mutationFn: async (approve: boolean) => {
      if (!ctx.data?.ok) throw new Error("no-context")
      const hasOptional = ctx.data.scopes.some((s) => s.optional)
      const granted = ctx.data.scopes.filter((s) => !s.optional || !optionalOff[s.scope]).map((s) => s.scope)
      return (await apiClient.post<{ redirect_to: string }>("/oauth/authorize/decision", {
        params,
        approve,
        consent_token: ctx.data.consent_token,
        // Chỉ gửi khi có scope tuỳ chọn — BE nhận tập con của scope đã hiển thị, không bao giờ rộng hơn.
        ...(approve && hasOptional ? { granted_scopes: granted } : {}),
      })).data
    },
    onSuccess: (res) => {
      const target = safeExternalRedirect(res.redirect_to)
      if (target) window.location.assign(target)
    },
  })

  const errorTarget = ctx.data && !ctx.data.ok ? safeExternalRedirect(ctx.data.redirect_to) : null
  useEffect(() => {
    // Lỗi tham số (PKCE/scope/resource…) sau khi redirect_uri đã được BE xác nhận ⇒ báo lại cho ứng dụng theo RFC 6749.
    if (errorTarget) window.location.replace(errorTarget)
  }, [errorTarget])

  if (ctx.isLoading) {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang kiểm tra yêu cầu...</div>
      </Shell>
    )
  }
  if (ctx.isError) return <ErrorCard text={errorText(ctx.error).text} />
  if (!ctx.data) return <ErrorCard text="Không có dữ liệu yêu cầu." />
  if (!ctx.data.ok) {
    return (
      <Shell>
        <Card><CardContent className="py-5 text-sm">
          Yêu cầu từ ứng dụng không hợp lệ. Đang quay lại ứng dụng...
          {errorTarget && <> Nếu trang không tự chuyển, <a className="font-medium text-primary underline" href={errorTarget}>bấm vào đây</a>.</>}
        </CardContent></Card>
      </Shell>
    )
  }

  const { client, scopes } = ctx.data
  const noScope = scopes.every((s) => s.optional && !!optionalOff[s.scope]) // client chỉ xin quyền tuỳ chọn mà chưa tick ⇒ chưa có gì để cấp
  const submitError = decide.isError ? errorText(decide.error) : null
  return (
    <Shell>
      <h1 className="text-xl font-semibold">Cho phép ứng dụng này truy cập Trinity CRM?</h1>
      <ConsentClient client={client} />

      <Card>
        <CardContent className="space-y-3 py-4">
          <p className="text-sm font-semibold">Ứng dụng sẽ được phép:</p>
          <ul className="space-y-2">
            {scopes.map((s) => (
              <li key={s.scope} className="text-sm">
                {s.optional ? (
                  <label className="flex min-h-11 cursor-pointer items-start gap-2">
                    <Checkbox
                      className="mt-1"
                      checked={!optionalOff[s.scope]}
                      disabled={decide.isPending}
                      onChange={(e) => setOptionalOff((prev) => ({ ...prev, [s.scope]: !e.target.checked }))}
                    />
                    <span>
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {s.label}
                        <Badge variant="secondary">Tuỳ chọn</Badge>
                      </span>
                      <span className="block text-muted-foreground">{s.description}</span>
                    </span>
                  </label>
                ) : (
                  <>
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {s.label}
                      {!s.available && <Badge variant="secondary">Chưa khả dụng</Badge>}
                    </p>
                    <p className="text-muted-foreground">{s.description}</p>
                  </>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Ứng dụng chỉ thấy dữ liệu bạn được xem. Bạn có thể thu hồi bất cứ lúc nào tại Cài đặt &gt; Kết nối &amp; AI &gt; Kết nối AI.
          </p>
        </CardContent>
      </Card>

      {email && <p className="text-xs text-muted-foreground">Đang đăng nhập với tài khoản <strong>{email}</strong>.</p>}
      {submitError && (
        <p className="flex items-start gap-2 text-sm text-red-700" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {submitError.text}
        </p>
      )}

      <MobileActionBar>
        <Button variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate(false)}>Từ chối</Button>
        <Button disabled={decide.isPending || noScope} onClick={() => decide.mutate(true)}>
          {decide.isPending && <Loader2 className="mr-1 size-4 animate-spin" />} Cho phép
        </Button>
      </MobileActionBar>
    </Shell>
  )
}
