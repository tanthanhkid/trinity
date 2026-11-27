"use client"

import { useEffect, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { acceptInvitation, previewInvitation, type InvitationPreview } from "@/lib/auth-api"
import { describeError, serverSentence } from "@/lib/error-messages"
import { setAccessToken, setRefreshToken, clearTokens } from "@/lib/token-storage"
import { useRouteParams } from "@/lib/route-params"
import { useAuthStore } from "@/store/auth"
import { LoginBrandPanel } from "../../login/_components/login-brand-panel"

const schema = z
  .object({
    full_name: z.string().trim().min(2, "Họ tên tối thiểu 2 ký tự").max(200),
    password: z.string().min(8, "Mật khẩu tối thiểu 8 ký tự").max(200),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Hai mật khẩu chưa giống nhau" })

type Values = z.infer<typeof schema>

type Phase = { kind: "loading" } | { kind: "ready"; invite: InvitationPreview } | { kind: "gone"; message: string }

/** Trang nhận lời mời (công khai): người được mời đặt tên + mật khẩu, tạo tài khoản trong công ty của người mời. */
export default function InvitePage() {
  const route = useRouteParams<"token">("/invite/:token")
  const hasRoute = route !== null
  const token = route ? decodeURIComponent(route.token ?? "") : ""
  const router = useRouter()
  const queryClient = useQueryClient()
  const setAuth = useAuthStore((s) => s.setAuth)
  const clearAuth = useAuthStore((s) => s.clearAuth)
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!hasRoute) return // bản xuất tĩnh: chưa biết token tới khi mount
    let alive = true
    previewInvitation(token)
      .then((invite) => alive && setPhase({ kind: "ready", invite }))
      .catch((err: unknown) => {
        if (!alive) return
        setPhase({ kind: "gone", message: serverSentence(err) ?? "Link mời không dùng được. Hãy nhờ chủ công ty gửi link mới." })
      })
    return () => {
      alive = false
    }
  }, [hasRoute, token])

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) })

  async function onSubmit(values: Values) {
    setError(null)
    try {
      const res = await acceptInvitation({ token, full_name: values.full_name, password: values.password })
      // Chỉ bỏ phiên đang đăng nhập (nếu có) SAU KHI nhận lời mời thành công — lỗi thì phiên cũ còn nguyên.
      queryClient.clear()
      clearTokens()
      clearAuth()
      setAccessToken(res.tokens.accessToken)
      setRefreshToken(res.tokens.refreshToken)
      setAuth({ user: res.user, roles: res.roles, permissions: res.permissions, isAdmin: res.isAdmin, company: res.company }, res.tokens)
      router.push("/dashboard")
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 410) setPhase({ kind: "gone", message: serverSentence(err) ?? "Link mời không còn hiệu lực." })
      else if (status === 429) setError("Quá nhiều lần thử, vui lòng thử lại sau")
      else setError(describeError(err, "Chưa tạo được tài khoản"))
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <LoginBrandPanel />
      <div className="relative flex items-center justify-center bg-background p-6 max-sm:items-start max-sm:pt-[8dvh] sm:p-10">
        <div className="relative w-full max-w-sm space-y-8">
          {phase.kind === "loading" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Đang kiểm tra lời mời...
            </div>
          )}

          {phase.kind === "gone" && (
            <div className="space-y-4">
              <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Lời mời không dùng được</h1>
              <div role="alert" className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
                {phase.message}
              </div>
              <Link href="/login" className="text-sm font-medium text-primary hover:underline">
                Về trang đăng nhập
              </Link>
            </div>
          )}

          {phase.kind === "ready" && (
            <>
              <div className="space-y-2">
                <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Tham gia {phase.invite.company_name || "công ty"}</h1>
                <p className="text-sm text-muted-foreground">
                  Bạn được mời bằng email <span className="font-medium text-foreground">{phase.invite.email}</span>
                  {phase.invite.role_name ? <> với vai trò <span className="font-medium text-foreground">{phase.invite.role_name}</span></> : null}. Đặt tên và mật khẩu để vào làm việc.
                </p>
              </div>
              <form className="space-y-5" method="post" onSubmit={handleSubmit(onSubmit)}>
                <Field id="full_name" label="Họ tên của bạn" error={errors.full_name?.message}>
                  <Input id="full_name" autoComplete="name" placeholder="Nguyễn Văn A" className="h-11 rounded-lg" {...register("full_name")} />
                </Field>
                <Field id="password" label="Mật khẩu" error={errors.password?.message}>
                  <Input id="password" type="password" autoComplete="new-password" placeholder="Tối thiểu 8 ký tự" className="h-11 rounded-lg" {...register("password")} />
                </Field>
                <Field id="confirm" label="Nhập lại mật khẩu" error={errors.confirm?.message}>
                  <Input id="confirm" type="password" autoComplete="new-password" className="h-11 rounded-lg" {...register("confirm")} />
                </Field>

                {error && (
                  <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive px-4 py-3 text-sm text-white">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                  </div>
                )}

                <Button type="submit" disabled={isSubmitting} className="h-11 w-full rounded-lg text-[15px]">
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      Đang tạo tài khoản...
                    </>
                  ) : (
                    "Tham gia"
                  )}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
