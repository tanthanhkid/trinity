"use client"

import { useEffect, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  acceptInvitation,
  acceptInvitationWithCode,
  getLoginMethods,
  previewInvitation,
  sendInvitationCode,
  type InvitationPreview,
  type LoginResult,
} from "@/lib/auth-api"
import { OtpInput, isCompleteCode } from "@/components/auth/otp-input"
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

const nameSchema = z.object({ full_name: z.string().trim().min(2, "Họ tên tối thiểu 2 ký tự").max(200) })
type NameValues = z.infer<typeof nameSchema>

/**
 * Trang nhận lời mời (công khai). Máy chủ gửi được mail (#675) ⇒ nhập họ tên, nhận mã 6 số ở email được mời, vào công ty —
 * không bắt đặt mật khẩu (đặt sau ở Cài đặt nếu muốn). Không gửi được mail ⇒ đặt tên + mật khẩu như trước.
 */
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
  /** `undefined` = đang hỏi; bật email ⇒ luồng mã, trừ khi người dùng chọn "đặt mật khẩu". */
  const [emailMode, setEmailMode] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void getLoginMethods().then((m) => alive && setEmailMode(m?.email_login_enabled === true))
    return () => {
      alive = false
    }
  }, [])

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

  function enter(res: LoginResult) {
    // Chỉ bỏ phiên đang đăng nhập (nếu có) SAU KHI nhận lời mời thành công — lỗi thì phiên cũ còn nguyên.
    queryClient.clear()
    clearTokens()
    clearAuth()
    setAccessToken(res.tokens.accessToken)
    setRefreshToken(res.tokens.refreshToken)
    setAuth({ user: res.user, roles: res.roles, permissions: res.permissions, isAdmin: res.isAdmin, company: res.company }, res.tokens)
    router.push("/dashboard")
  }

  function onFail(err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status === 410) setPhase({ kind: "gone", message: serverSentence(err) ?? "Link mời không còn hiệu lực." })
    else if (status === 429) setError(serverSentence(err) ?? "Quá nhiều lần thử, vui lòng thử lại sau")
    else setError(describeError(err, "Chưa tạo được tài khoản"))
  }

  async function onSubmit(values: Values) {
    setError(null)
    try {
      enter(await acceptInvitation({ token, full_name: values.full_name, password: values.password }))
    } catch (err: unknown) {
      onFail(err)
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

          {phase.kind === "ready" && emailMode === undefined && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Đang tải...
            </div>
          )}

          {phase.kind === "ready" && emailMode === true && (
            <CodeJoin
              token={token}
              invite={phase.invite}
              onDone={enter}
              onFail={onFail}
              error={error}
              setError={setError}
              onUsePassword={() => {
                setError(null)
                setEmailMode(false)
              }}
            />
          )}

          {phase.kind === "ready" && emailMode === false && (
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

/** Nhận lời mời bằng mã gửi tới email được mời (#675). */
function CodeJoin({
  token,
  invite,
  onDone,
  onFail,
  error,
  setError,
  onUsePassword,
}: {
  token: string
  invite: InvitationPreview
  onDone: (r: LoginResult) => void
  onFail: (err: unknown) => void
  error: string | null
  setError: (m: string | null) => void
  onUsePassword: () => void
}) {
  const [sent, setSent] = useState<{ name: string; masked: string } | null>(null)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [left, setLeft] = useState(0)
  /** Khoá đồng bộ chống gửi mã hai lần (tự gửi khi đủ 6 số + bấm nút). */
  const inFlight = useRef(false)
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<NameValues>({ resolver: zodResolver(nameSchema) })

  useEffect(() => {
    if (left <= 0) return
    const t = setTimeout(() => setLeft((v) => v - 1), 1000)
    return () => clearTimeout(t)
  }, [left])

  async function send(values: NameValues) {
    setError(null)
    try {
      const r = await sendInvitationCode(token)
      setSent({ name: values.full_name.trim(), masked: r.email })
      setLeft(r.resend_after ?? 30)
      setCode("")
    } catch (err: unknown) {
      onFail(err)
    }
  }

  async function join(value: string) {
    if (!sent || inFlight.current || !isCompleteCode(value)) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      onDone(await acceptInvitationWithCode({ token, full_name: sent.name, code: value }))
    } catch (err: unknown) {
      inFlight.current = false
      setCode("")
      const msg = serverSentence(err)
      if (msg && /hết hạn|quá 5 lần/i.test(msg)) setLeft(0)
      onFail(err)
      setBusy(false)
    }
  }

  return (
    <>
      <div className="space-y-2">
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Tham gia {invite.company_name || "công ty"}</h1>
        <p className="text-sm text-muted-foreground">
          Bạn được mời bằng email <span className="font-medium text-foreground">{invite.email}</span>
          {invite.role_name ? <> với vai trò <span className="font-medium text-foreground">{invite.role_name}</span></> : null}.{" "}
          {sent ? <>Đã gửi mã tới <span className="font-medium text-foreground">{sent.masked}</span>, nhập mã để vào làm việc.</> : "Nhập họ tên, Trinity gửi mã xác nhận tới email này."}
        </p>
      </div>

      {!sent ? (
        <form className="space-y-5" method="post" onSubmit={handleSubmit(send)}>
          <Field id="full_name" label="Họ tên của bạn" error={errors.full_name?.message}>
            <Input id="full_name" autoComplete="name" placeholder="Nguyễn Văn A" className="h-11 rounded-lg" {...register("full_name")} />
          </Field>
          {error && <InviteError message={error} />}
          <Button type="submit" disabled={isSubmitting} className="h-11 w-full rounded-lg text-[15px]">
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Đang gửi mã...
              </>
            ) : (
              "Gửi mã xác nhận"
            )}
          </Button>
        </form>
      ) : (
        <form
          className="space-y-5"
          method="post"
          onSubmit={(e) => {
            e.preventDefault()
            void join(code)
          }}
        >
          <OtpInput value={code} onChange={setCode} onComplete={(v) => void join(v)} disabled={busy} invalid={!!error} autoFocus />
          {error && <InviteError message={error} />}
          <Button type="submit" disabled={busy || !isCompleteCode(code)} className="h-11 w-full rounded-lg text-[15px]">
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Đang tạo tài khoản...
              </>
            ) : (
              "Tham gia"
            )}
          </Button>
          <div className="flex items-center justify-end text-sm">
            {left > 0 ? (
              <span className="text-muted-foreground" aria-live="polite">
                Gửi lại sau {left} s
              </span>
            ) : (
              <button type="button" className="min-h-11 font-medium text-primary hover:underline" onClick={() => void send({ full_name: sent.name })}>
                Gửi lại mã
              </button>
            )}
          </div>
        </form>
      )}

      <p className="text-center text-sm text-muted-foreground">
        <button type="button" className="min-h-11 font-medium text-primary hover:underline" onClick={onUsePassword}>
          Đặt mật khẩu thay vì nhận mã
        </button>
      </p>
    </>
  )
}

function InviteError({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive px-4 py-3 text-sm text-white">
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
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
