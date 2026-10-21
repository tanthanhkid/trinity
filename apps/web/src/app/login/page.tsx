"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useRouter } from "next/navigation"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CircleAlert, Eye, EyeOff, Loader2 } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { login } from "@/lib/auth-api"
import { resetLogoutState } from "@/lib/api-client"
import { describeError, serverSentence } from "@/lib/error-messages"
import { logFrontendError } from "@/lib/fe-logger"
import { setAccessToken, setRefreshToken, clearTokens } from "@/lib/token-storage"
import { useAuthStore } from "@/store/auth"
import { useAppDocumentTheme } from "@/hooks/use-app-shell"
import { appFont } from "@/lib/app-font"
import { safeNextPath } from "@/lib/oauth-authorize"
import { LoginBrandPanel } from "./_components/login-brand-panel"

const loginSchema = z.object({
  email: z.string().min(1, "Email không được để trống").regex(/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/, "Email không hợp lệ"),
  password: z.string().min(6, "Mật khẩu tối thiểu 6 ký tự"),
})

type LoginFormValues = z.infer<typeof loginSchema>

/**
 * `true` sau khi React đã hydrate, `false` lúc render trên server.
 *
 * Dùng `useSyncExternalStore` chứ KHÔNG `useState(false)` + `useEffect(() =>
 * setMounted(true), [])`: cách sau là cascading render và bị eslint
 * `react-hooks/set-state-in-effect` chặn (repo coi rule này là cổng — xem
 * `hooks/use-app-shell.ts` đã né đúng cách này cho `useAppNavMini`).
 * `getServerSnapshot` trả `false` nên HTML server render ra đã mang sẵn
 * `disabled` trên nút submit — đúng thứ ta cần cho cửa sổ chưa hydrate.
 */
const subscribeNever = () => () => {}
const getHydratedSnapshot = () => true
const getHydratedServerSnapshot = () => false

function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    getHydratedSnapshot,
    getHydratedServerSnapshot,
  )
}

export default function LoginPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { setAuth, clearAuth } = useAuthStore()
  const hasHydrated = useAuthStore((s) => s._hasHydrated)
  const [showPassword, setShowPassword] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)

  /**
   * 🔴 Chống RÒ MẬT KHẨU QUA URL.
   *
   * `<form>` này không có `action`/`method` nên MẶC ĐỊNH của HTML là **GET về
   * chính URL hiện tại**. Trước khi React hydrate xong, `onSubmit` chưa gắn ⇒
   * bấm "Đăng nhập" (hoặc Enter) chạy submit NATIVE và trình duyệt điều hướng
   * tới `/login?email=…&password=…`. Mật khẩu rõ khi đó vào: dòng yêu cầu
   * của máy chủ, header `Referer` của MỌI request tiếp theo phát từ trang đó, và
   * lịch sử trình duyệt của user.
   *
   * Đây KHÔNG phải giả thuyết: mật khẩu rõ nằm trong access log và header `Referer`
   * của các request tiếp theo.
   *
   * Vá 2 lớp, cố ý thừa — mỗi lớp tự nó đủ chặn, giữ cả hai để lớp này hỏng
   * thì lớp kia còn:
   *  1. `method="post"` trên <form> (dưới) — submit native khi đó gửi field
   *     trong THÂN request, không bao giờ vào URL. Đúng kể cả khi JS tắt hẳn.
   *  2. `useHydrated()` (ở đây) khoá nút submit tới khi React đã hydrate. Nút
   *     submit mặc định bị disabled cũng chặn LUÔN "implicit submission" bằng
   *     Enter (HTML spec: activation behavior của nút disabled không chạy) ⇒
   *     thực tế submit native không còn xảy ra. Đo thật: HTML do server render
   *     đã mang sẵn `disabled`, nên cửa sổ chưa-hydrate cũng không bấm được.
   *
   * ⚠️ KHÔNG dùng `hasHydrated` (cờ rehydrate của Zustand persist) cho việc
   * này: nếu rehydrate lỗi thì cờ đó kẹt `false` và nút khoá VĨNH VIỄN — khoá
   * toàn bộ đường đăng nhập, hậu quả nặng hơn bug đang sửa. `useHydrated()`
   * chỉ phụ thuộc việc React đã hydrate, không phụ thuộc storage.
 */
  const mounted = useHydrated()

  // Gắn `data-ui="app"` + font cho màn đăng nhập, cùng 1 hook với cây
  // `(dashboard)` để token và phần vá tương phản áp nhất quán ở cả hai.
  useAppDocumentTheme(appFont.variable)

  // LUÔN clear (không check accessToken) vì stale trinity_access_token /
  // trinity_refresh_token trong
  // localStorage có thể còn tồn tại dù Zustand store đã null (race giữa logout
  // flow và persist rehydrate). `clearTokens()` xoá cả 4 key.
  useEffect(() => {
    if (!hasHydrated) return
    resetLogoutState()
    queryClient.clear()
    clearTokens()
    clearAuth()
  }, [hasHydrated]) // eslint-disable-line react-hooks/exhaustive-deps

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  })

  async function onSubmit(values: LoginFormValues) {
    setLoginError(null)
    try {
      // điện thoại tự viết hoa chữ cái đầu ô email (autocapitalize
      // mặc định của bàn phím) khiến 1 tài khoản không đăng nhập được dù mật khẩu
      // đúng. BE nay tra cứu email không phân biệt hoa/thường, nhưng chuẩn hoá
      // ngay tại FE (trim + lowercase) để tránh lớp lỗi này phát sinh ngay từ đầu
      // — KHÔNG thay cho fix BE, chỉ là hàng rào bổ sung cho đường web.
      const normalizedEmail = values.email.trim().toLowerCase()
      const { user, roles, permissions, isAdmin, tokens } = await login(normalizedEmail, values.password)
      setAccessToken(tokens.accessToken)
      setRefreshToken(tokens.refreshToken)
      setAuth({ user, roles, permissions, isAdmin }, tokens)
      // đang dở luồng cấp quyền AI (middleware chuyển `/oauth/authorize?...` sang `/login?next=...`) ⇒ quay lại đúng trang
      // đồng ý. Chỉ nhận `/oauth/authorize` (safeNextPath) — không dùng `next` làm open redirect. Đọc URL lúc submit (không cần
      // useSearchParams/Suspense).
      const next = safeNextPath(new URLSearchParams(window.location.search).get("next"))
      router.push(next ?? "/dashboard")
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      // Chỉ dùng câu tiếng Việt máy chủ viết sẵn; chữ tiếng Anh ("Unauthorized") thay bằng câu của mình.
      const serverMsg = serverSentence(err) ?? undefined

      if (status === 401) {
        setLoginError(serverMsg ?? "Email hoặc mật khẩu không đúng")
      } else if (status === 400) {
        setLoginError(serverMsg ?? "Email hoặc mật khẩu không hợp lệ")
      } else if (status === 429) {
        setLoginError(serverMsg ?? "Quá nhiều lần thử đăng nhập, vui lòng thử lại sau")
      } else {
        logFrontendError(err, { component: "login", context: "submit", status })
        // Mất mạng / máy chủ lỗi / bảo trì: mỗi loại một câu nói rõ + cách sửa (bảng thông điệp chung).
        setLoginError(describeError(err, "Chưa đăng nhập được"))
      }
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <LoginBrandPanel />

      <div className="relative flex items-center justify-center bg-background p-6 max-sm:items-start max-sm:pt-[12dvh] sm:p-10">
        <div className="relative w-full max-w-sm space-y-8">
          <div className="flex flex-col items-center gap-2 lg:hidden">
            <Image
              src="/logo/trinity-mark.png"
              alt=""
              width={220}
              height={295}
              priority
              className="h-11 w-auto"
            />
            <div className="text-lg font-semibold tracking-tight text-foreground">
              Trinity
            </div>
          </div>

          <div className="space-y-2">
            <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
              Đăng nhập
            </h1>
            <p className="text-sm text-muted-foreground">
              Dùng tài khoản nội bộ Trinity để tiếp tục.
            </p>
          </div>

          {/* `method="post"` là lớp 1 của bản vá rò mật khẩu qua URL — xem
              docblock ở `const [mounted, …]` phía trên. TUYỆT ĐỐI KHÔNG gỡ
              thuộc tính này kể cả khi thấy "thừa vì đã có preventDefault". */}
          <form className="space-y-5" method="post" onSubmit={handleSubmit(onSubmit)}>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
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
              {errors.email && (
                <p className="text-sm text-destructive">{errors.email.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Mật khẩu</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Nhập mật khẩu"
                  className="h-11 rounded-lg pr-11"
                  {...register("password")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
              {errors.password && (
                <p className="text-sm text-destructive">{errors.password.message}</p>
              )}
            </div>

            {loginError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg bg-destructive px-4 py-3 text-sm text-white"
              >
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{loginError}</span>
              </div>
            )}

            <Button
              type="submit"
              disabled={isSubmitting || !mounted}
              className="h-11 w-full rounded-lg bg-primary text-[15px] text-primary-foreground hover:bg-primary/90"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  Đang đăng nhập...
                </>
              ) : (
                "Đăng nhập"
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
