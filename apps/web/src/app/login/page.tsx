"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useRouter } from "next/navigation"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ArrowLeft, CircleAlert, Eye, EyeOff, Loader2, Mail } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import {
  getLoginMethods,
  googleStartUrl,
  isSignupEnabled,
  login,
  startEmailLogin,
  verifyEmailCode,
  type LoginMethods,
  type LoginResult,
} from "@/lib/auth-api"
import { buttonVariants } from "@/components/ui/button-variants"
import { OtpInput, isCompleteCode } from "@/components/auth/otp-input"
import { GoogleMark } from "@/components/auth/google-mark"
import { cn } from "@/lib/utils"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
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

const emailOnlySchema = loginSchema.pick({ email: true })
type EmailFormValues = z.infer<typeof emailOnlySchema>

/** Bước của màn đăng nhập: nhập email → nhập mã; "password" là đường phụ cho tài khoản cũ. */
type Step = { kind: "start" } | { kind: "code"; email: string; masked: string; resendAfter: number } | { kind: "password" }

/** `?error=google&message=…` do máy chủ chuyển về sau Google (huỷ, không có tài khoản, tài khoản khoá…). */
function readUrlError(): string | null {
  if (typeof window === "undefined") return null
  const q = new URLSearchParams(window.location.search)
  if (!q.get("error")) return null
  return q.get("message") || "Chưa đăng nhập được bằng Google. Hãy thử lại."
}

function readNext(): string | null {
  if (typeof window === "undefined") return null
  return safeNextPath(new URLSearchParams(window.location.search).get("next"))
}

export default function LoginPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { setAuth, clearAuth } = useAuthStore()
  const hasHydrated = useAuthStore((s) => s._hasHydrated)
  const [loginError, setLoginError] = useState<string | null>(null)
  /** `undefined` = đang hỏi máy chủ; `null` = máy chủ không trả (bản cũ / lỗi) ⇒ chỉ mật khẩu như trước. */
  const [methods, setMethods] = useState<LoginMethods | null | undefined>(undefined)
  const [step, setStep] = useState<Step>({ kind: "start" })

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
   * Cùng luật cho form email và form mã (#675).
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

  // Cách đăng nhập máy chủ bật + đăng ký công ty + lỗi Google trên URL.
  const [signupOpen, setSignupOpen] = useState(false)
  const [urlError, setUrlError] = useState<string | null>(null)
  // Lỗi Google trên URL đọc SAU mount (HTML server không có ⇒ không lệch hydrate), rồi bỏ query khỏi thanh địa chỉ
  // (giữ `history.state` của Next) để tải lại không hiện lại lỗi cũ.
  useEffect(() => {
    const e = readUrlError()
    if (!e) return
    queueMicrotask(() => setUrlError(e))
    const u = new URL(window.location.href)
    u.searchParams.delete("error")
    u.searchParams.delete("message")
    window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`)
  }, [])
  /** Người dùng bắt đầu lượt mới ⇒ bỏ cả lỗi Google cũ. */
  const report = (m: string | null) => {
    setUrlError(null)
    setLoginError(m)
  }
  useEffect(() => {
    let alive = true
    void getLoginMethods().then((m) => {
      if (!alive) return
      setMethods(m)
      if (m) setSignupOpen(m.signup_enabled)
      else void isSignupEnabled().then((v) => alive && setSignupOpen(v))
    })
    return () => {
      alive = false
    }
  }, [])

  const emailEnabled = methods?.email_login_enabled === true
  const googleEnabled = methods?.google_enabled === true
  // Máy chủ cũ (không trả `methods`) hoặc không bật email ⇒ form mật khẩu là màn chính như trước.
  const passwordEnabled = methods === null || methods?.password_login_enabled !== false
  const passwordPrimary = methods === null || (methods !== undefined && !emailEnabled)
  const showPassword = passwordEnabled && (passwordPrimary || step.kind === "password")

  function finish(res: LoginResult) {
    setAccessToken(res.tokens.accessToken)
    setRefreshToken(res.tokens.refreshToken)
    setAuth({ user: res.user, roles: res.roles, permissions: res.permissions, isAdmin: res.isAdmin, company: res.company }, res.tokens)
    // đang dở luồng cấp quyền AI (middleware chuyển `/oauth/authorize?...` sang `/login?next=...`) ⇒ quay lại đúng trang
    // đồng ý. Chỉ nhận `/oauth/authorize` (safeNextPath) — không dùng `next` làm open redirect.
    router.push(readNext() ?? "/dashboard")
  }

  const shownError = loginError ?? urlError

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

          {step.kind === "code" ? (
            <CodeStep
              email={step.email}
              masked={step.masked}
              resendAfter={step.resendAfter}
              mounted={mounted}
              onDone={finish}
              onBack={() => {
                report(null)
                setStep({ kind: "start" })
              }}
            />
          ) : (
            <>
              <div className="space-y-2">
                <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
                  Đăng nhập
                </h1>
                <p className="text-sm text-muted-foreground">
                  {showPassword && !passwordPrimary
                    ? "Đăng nhập bằng email và mật khẩu của tài khoản."
                    : emailEnabled
                      ? "Nhập email công việc, Trinity gửi mã đăng nhập tới hộp thư của bạn."
                      : "Dùng tài khoản nội bộ Trinity để tiếp tục."}
                </p>
              </div>

              {shownError && <ErrorBox message={shownError} />}

              {methods === undefined && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Đang tải...
                </div>
              )}

              {methods !== undefined && emailEnabled && !showPassword && (
                <EmailStep
                  mounted={mounted}
                  onSent={(email, masked, resendAfter) => {
                    report(null)
                    setStep({ kind: "code", email, masked, resendAfter })
                  }}
                  onError={report}
                />
              )}

              {showPassword && (
                <PasswordForm mounted={mounted} onDone={finish} onError={report} />
              )}

              {methods !== undefined && googleEnabled && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
                    <span className="h-px flex-1 bg-border" />
                    hoặc
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <a
                    href={googleStartUrl(readNext())}
                    className={cn(buttonVariants({ variant: "outline" }), "h-11 w-full gap-2 rounded-lg text-[15px]")}
                  >
                    <GoogleMark />
                    Tiếp tục với Google
                  </a>
                </div>
              )}

              {methods !== undefined && emailEnabled && passwordEnabled && (
                <p className="text-center text-sm text-muted-foreground">
                  {showPassword ? (
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={() => {
                        report(null)
                        setStep({ kind: "start" })
                      }}
                    >
                      Đăng nhập bằng mã gửi qua email
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={() => {
                        report(null)
                        setStep({ kind: "password" })
                      }}
                    >
                      Đăng nhập bằng mật khẩu
                    </button>
                  )}
                </p>
              )}
            </>
          )}

          {signupOpen && step.kind !== "code" && (
            <p className="text-center text-sm text-muted-foreground">
              Chưa có tài khoản?{" "}
              <Link href="/register" className="font-medium text-primary hover:underline">
                Đăng ký công ty mới
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive px-4 py-3 text-sm text-white">
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}


/** Bước 1: nhập email, máy chủ gửi mã + link. */
function EmailStep({
  mounted,
  onSent,
  onError,
}: {
  mounted: boolean
  onSent: (email: string, masked: string, resendAfter: number) => void
  onError: (m: string | null) => void
}) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EmailFormValues>({ resolver: zodResolver(emailOnlySchema) })

  async function onSubmit(values: EmailFormValues) {
    onError(null)
    const email = values.email.trim().toLowerCase()
    try {
      const r = await startEmailLogin(email)
      onSent(email, r.email, r.resend_after ?? 30)
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 429) onError(serverSentence(err) ?? "Bạn thử quá nhiều lần, vui lòng đợi một lát rồi thử lại")
      else {
        logFrontendError(err, { component: "login", context: "email-start", status })
        onError(describeError(err, "Chưa gửi được mã"))
      }
    }
  }

  return (
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
        {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
      </div>
      <Button
        type="submit"
        disabled={isSubmitting || !mounted}
        className="h-11 w-full gap-2 rounded-lg bg-primary text-[15px] text-primary-foreground hover:bg-primary/90"
      >
        {isSubmitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Đang gửi mã...
          </>
        ) : (
          <>
            <Mail className="h-4 w-4" aria-hidden="true" />
            Tiếp tục với email
          </>
        )}
      </Button>
    </form>
  )
}

/** Bước 2: nhập mã 6 số (dán một lần, đủ 6 số tự gửi), đếm ngược gửi lại, đổi email. */
function CodeStep({
  email,
  masked,
  resendAfter,
  mounted,
  onDone,
  onBack,
}: {
  email: string
  masked: string
  resendAfter: number
  mounted: boolean
  onDone: (r: LoginResult) => void
  onBack: () => void
}) {
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [left, setLeft] = useState(resendAfter)
  const [sentTo, setSentTo] = useState(masked)
  // Khoá đồng bộ: đủ 6 số tự gửi + bấm nút cùng lúc không gửi mã hai lần (state `busy` chỉ cập nhật ở lần render sau).
  const inFlight = useRef(false)

  useEffect(() => {
    if (left <= 0) return
    const t = setTimeout(() => setLeft((v) => v - 1), 1000)
    return () => clearTimeout(t)
  }, [left])

  async function submit(value: string) {
    if (inFlight.current || !isCompleteCode(value)) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      onDone(await verifyEmailCode(email, value))
    } catch (err: unknown) {
      inFlight.current = false
      const status = (err as { response?: { status?: number } })?.response?.status
      const msg = serverSentence(err)
      setCode("")
      if (status === 400 || status === 401 || status === 403) {
        setError(msg ?? "Mã không đúng hoặc đã hết hạn")
        // Hết hạn / sai quá 5 lần ⇒ cho gửi lại ngay.
        if (msg && /hết hạn|quá 5 lần|gửi lại/i.test(msg)) setLeft(0)
      } else if (status === 429) {
        setError(msg ?? "Bạn thử quá nhiều lần, vui lòng đợi một lát rồi thử lại")
      } else {
        logFrontendError(err, { component: "login", context: "email-verify", status })
        setError(describeError(err, "Chưa đăng nhập được"))
      }
      setBusy(false)
    }
  }

  async function resend() {
    setError(null)
    setInfo(null)
    try {
      const r = await startEmailLogin(email)
      setSentTo(r.email)
      setLeft(r.resend_after ?? 30)
      setCode("")
      setInfo("Đã gửi mã mới. Mã cũ không còn dùng được.")
    } catch (err: unknown) {
      setError(describeError(err, "Chưa gửi lại được mã"))
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Kiểm tra hộp thư</h1>
        <p className="text-sm text-muted-foreground">
          Đã gửi mã tới <span className="font-medium text-foreground">{sentTo}</span>. Nhập mã 6 số, hoặc bấm link trong thư
          trên máy này. Mã hết hạn sau 10 phút.
        </p>
      </div>

      <form
        className="space-y-5"
        method="post"
        onSubmit={(e) => {
          e.preventDefault()
          void submit(code)
        }}
      >
        <OtpInput value={code} onChange={setCode} onComplete={(v) => void submit(v)} disabled={busy || !mounted} invalid={!!error} autoFocus />
        {error && <ErrorBox message={error} />}
        {info && (
          <p className="text-sm text-muted-foreground" role="status">
            {info}
          </p>
        )}
        <Button
          type="submit"
          disabled={busy || !mounted || !isCompleteCode(code)}
          className="h-11 w-full rounded-lg bg-primary text-[15px] text-primary-foreground hover:bg-primary/90"
        >
          {busy ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              Đang đăng nhập...
            </>
          ) : (
            "Đăng nhập"
          )}
        </Button>
      </form>

      <div className="flex items-center justify-between text-sm">
        <button type="button" onClick={onBack} className="inline-flex min-h-11 items-center gap-1 font-medium text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Dùng email khác
        </button>
        {left > 0 ? (
          <span className="text-muted-foreground" aria-live="polite">
            Gửi lại sau {left} s
          </span>
        ) : (
          <button type="button" onClick={() => void resend()} className="min-h-11 font-medium text-primary hover:underline">
            Gửi lại mã
          </button>
        )}
      </div>
    </div>
  )
}

/** Đường phụ: email + mật khẩu (tài khoản cũ). */
function PasswordForm({
  mounted,
  onDone,
  onError,
}: {
  mounted: boolean
  onDone: (r: LoginResult) => void
  onError: (m: string | null) => void
}) {
  const [showPassword, setShowPassword] = useState(false)
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  })

  async function onSubmit(values: LoginFormValues) {
    onError(null)
    try {
      // điện thoại tự viết hoa chữ cái đầu ô email (autocapitalize
      // mặc định của bàn phím) khiến 1 tài khoản không đăng nhập được dù mật khẩu
      // đúng. BE nay tra cứu email không phân biệt hoa/thường, nhưng chuẩn hoá
      // ngay tại FE (trim + lowercase) để tránh lớp lỗi này phát sinh ngay từ đầu
      // — KHÔNG thay cho fix BE, chỉ là hàng rào bổ sung cho đường web.
      const normalizedEmail = values.email.trim().toLowerCase()
      onDone(await login(normalizedEmail, values.password))
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      // Chỉ dùng câu tiếng Việt máy chủ viết sẵn; chữ tiếng Anh ("Unauthorized") thay bằng câu của mình.
      const serverMsg = serverSentence(err) ?? undefined

      if (status === 401) {
        onError(serverMsg ?? "Email hoặc mật khẩu không đúng")
      } else if (status === 400) {
        onError(serverMsg ?? "Email hoặc mật khẩu không hợp lệ")
      } else if (status === 403) {
        onError(serverMsg ?? "Bản cài đặt này đã tắt đăng nhập bằng mật khẩu")
      } else if (status === 429) {
        onError(serverMsg ?? "Quá nhiều lần thử đăng nhập, vui lòng thử lại sau")
      } else {
        logFrontendError(err, { component: "login", context: "submit", status })
        // Mất mạng / máy chủ lỗi / bảo trì: mỗi loại một câu nói rõ + cách sửa (bảng thông điệp chung).
        onError(describeError(err, "Chưa đăng nhập được"))
      }
    }
  }

  return (
    // `method="post"` là lớp 1 của bản vá rò mật khẩu qua URL — xem docblock ở `const mounted` phía trên. TUYỆT ĐỐI
    // KHÔNG gỡ thuộc tính này kể cả khi thấy "thừa vì đã có preventDefault".
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
        {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
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
            {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
        {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
      </div>

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
  )
}
