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
import { isSignupEnabled, registerCompany } from "@/lib/auth-api"
import { describeError, serverSentence } from "@/lib/error-messages"
import { setAccessToken, setRefreshToken, clearTokens } from "@/lib/token-storage"
import { useAuthStore } from "@/store/auth"
import { LoginBrandPanel } from "../login/_components/login-brand-panel"

const schema = z.object({
  company_name: z.string().trim().min(2, "Tên công ty tối thiểu 2 ký tự").max(200),
  full_name: z.string().trim().min(2, "Họ tên tối thiểu 2 ký tự").max(200),
  email: z.string().trim().min(1, "Email không được để trống").email("Email không hợp lệ"),
  password: z.string().min(8, "Mật khẩu tối thiểu 8 ký tự").max(200),
})

type Values = z.infer<typeof schema>

/** Đăng ký: mỗi tài khoản là một công ty riêng, dữ liệu tách biệt hoàn toàn với công ty khác. */
export default function RegisterPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const setAuth = useAuthStore((s) => s.setAuth)
  const clearAuth = useAuthStore((s) => s.clearAuth)
  const [error, setError] = useState<string | null>(null)
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    void isSignupEnabled().then((v) => alive && setEnabled(v))
    return () => {
      alive = false
    }
  }, [])

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) })

  async function onSubmit(values: Values) {
    setError(null)
    try {
      queryClient.clear()
      clearTokens()
      clearAuth()
      const res = await registerCompany({ ...values, email: values.email.trim().toLowerCase() })
      setAccessToken(res.tokens.accessToken)
      setRefreshToken(res.tokens.refreshToken)
      setAuth({ user: res.user, roles: res.roles, permissions: res.permissions, isAdmin: res.isAdmin, company: res.company }, res.tokens)
      router.push("/dashboard")
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 409) setError(serverSentence(err) ?? "Email này đã được dùng — hãy đăng nhập")
      else if (status === 429) setError("Quá nhiều lần đăng ký, vui lòng thử lại sau")
      else if (status === 400) setError(serverSentence(err) ?? "Thông tin chưa hợp lệ")
      else setError(describeError(err, "Chưa đăng ký được"))
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <LoginBrandPanel />
      <div className="relative flex items-center justify-center bg-background p-6 max-sm:items-start max-sm:pt-[8dvh] sm:p-10">
        <div className="relative w-full max-w-sm space-y-8">
          <div className="space-y-2">
            <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Đăng ký công ty mới</h1>
            <p className="text-sm text-muted-foreground">
              Mỗi tài khoản là một công ty riêng. Dữ liệu và kênh kết nối của bạn không ai khác thấy được.
            </p>
          </div>

          {enabled === false ? (
            <div role="alert" className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
              Bản cài đặt này không mở đăng ký. <Link href="/login" className="font-medium text-primary hover:underline">Về trang đăng nhập</Link>
            </div>
          ) : (
            <form className="space-y-5" method="post" onSubmit={handleSubmit(onSubmit)}>
              <Field id="company_name" label="Tên công ty" error={errors.company_name?.message}>
                <Input id="company_name" autoComplete="organization" placeholder="Công ty ABC" className="h-11 rounded-lg" {...register("company_name")} />
              </Field>
              <Field id="full_name" label="Họ tên của bạn" error={errors.full_name?.message}>
                <Input id="full_name" autoComplete="name" placeholder="Nguyễn Văn A" className="h-11 rounded-lg" {...register("full_name")} />
              </Field>
              <Field id="email" label="Email" error={errors.email?.message}>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode="email"
                  placeholder="email@congty.vn"
                  className="h-11 rounded-lg"
                  {...register("email")}
                />
              </Field>
              <Field id="password" label="Mật khẩu" error={errors.password?.message}>
                <Input id="password" type="password" autoComplete="new-password" placeholder="Tối thiểu 8 ký tự" className="h-11 rounded-lg" {...register("password")} />
              </Field>

              {error && (
                <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive px-4 py-3 text-sm text-white">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}

              <Button type="submit" disabled={isSubmitting || enabled === null} className="h-11 w-full rounded-lg text-[15px]">
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                    Đang tạo công ty...
                  </>
                ) : (
                  "Đăng ký"
                )}
              </Button>
            </form>
          )}

          <p className="text-center text-sm text-muted-foreground">
            Đã có tài khoản?{" "}
            <Link href="/login" className="font-medium text-primary hover:underline">
              Đăng nhập
            </Link>
          </p>
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
