"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, LogOut, PartyPopper } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getApiErrorMessage } from "@/lib/api-client"
import { logout } from "@/lib/auth-api"
import { useAuthStore } from "@/store/auth"
import { useFinishWizard, useWizardAction, type WizardStepKey, type WizardView } from "@/hooks/use-onboarding-wizard"
import { STEP_TEXT, StepBody } from "./wizard-steps"

/**
 * Wizard bắt đầu — TOÀN MÀN HÌNH, không menu: mỗi lúc một nhiệm vụ. "Tôi đã làm xong" gửi máy chủ kiểm thật;
 * chưa đạt thì hiện việc còn thiếu và đứng yên ở bước đó. Bước công ty đã đạt hiện dấu xong, bấm Tiếp tục là qua.
 */
export function OnboardingWizard({ wizard: initial }: { wizard: WizardView }) {
  const router = useRouter()
  const qc = useQueryClient()
  const { clearAuth } = useAuthStore()
  const finish = useFinishWizard()
  const confirm = useWizardAction("confirm")
  const skip = useWizardAction("skip")
  const [wizard, setWizard] = useState(initial)
  const steps = wizard.steps
  const startKey = wizard.current ?? steps[steps.length - 1]?.key
  const [index, setIndex] = useState(() => Math.max(0, steps.findIndex((s) => s.key === startKey)))
  const [message, setMessage] = useState<string | null>(null)
  const [finished, setFinished] = useState<WizardView | null>(null)

  const step = steps[index]
  const busy = confirm.isPending || skip.isPending
  const passed = !!step && (step.done || step.skipped)
  const last = index === steps.length - 1

  const goTo = (key: WizardStepKey | null) => {
    setMessage(null)
    const i = key ? steps.findIndex((s) => s.key === key) : steps.length - 1
    setIndex(i < 0 ? steps.length - 1 : i)
  }

  const handle = (kind: "confirm" | "skip") => {
    if (!step) return
    const m = kind === "confirm" ? confirm : skip
    m.mutate(step.key, {
      onSuccess: (r) => {
        setWizard(r.wizard)
        if (!r.ok) return setMessage(r.message)
        if (r.wizard.completed) return setFinished(r.wizard)
        // Đạt bước này: sang bước kế mà máy chủ báo còn phải làm (bỏ qua các bước công ty đã đạt sẵn).
        const next = r.wizard.current
        if (next) goTo(next)
        else setIndex((i) => Math.min(i + 1, steps.length - 1))
        setMessage(null)
      },
      onError: (err) => setMessage(getApiErrorMessage(err, "Chưa kiểm được, bạn thử bấm lại sau ít giây.")),
    })
  }

  const handleLogout = async () => {
    await logout(clearAuth)
    qc.clear()
    router.push("/login")
  }

  const enterApp = () => {
    if (finished) finish(finished)
    router.replace("/dashboard")
  }

  return (
    <div className="flex min-h-dvh flex-col bg-muted/40" data-testid="onboarding-wizard">
      <header className="flex items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-6">
        <span className="text-base font-semibold tracking-tight">Trinity</span>
        {!finished && (
          <span className="text-sm text-muted-foreground" data-testid="wizard-progress">
            Bước {index + 1}/{steps.length}
          </span>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={handleLogout} className="max-sm:h-11">
          <LogOut aria-hidden /> Đăng xuất
        </Button>
      </header>
      <div className="h-1.5 bg-muted" aria-hidden>
        <div className="h-full bg-primary transition-all" style={{ width: `${finished ? 100 : (steps.filter((s) => s.done || s.skipped).length / Math.max(steps.length, 1)) * 100}%` }} />
      </div>

      <main className="mx-auto w-full max-w-2xl flex-1 space-y-5 px-4 py-8 sm:px-6">
        {finished ? (
          <section className="space-y-4 rounded-2xl border bg-card p-6 text-center" data-testid="wizard-finished">
            <PartyPopper className="mx-auto size-10 text-primary" aria-hidden />
            <h1 className="text-2xl font-semibold">Xong rồi! Trinity đã sẵn sàng</h1>
            <p className="text-sm text-muted-foreground">
              Từ giờ bạn làm việc với Trinity ngay trong khung chat với trợ lý AI: hỏi tình hình, thêm khách, giao việc bằng lời. Mọi việc AI làm đều ghi lại ở mục Hoạt động AI. Mở lại hướng dẫn ở mục Bắt đầu trên menu.
            </p>
            <Button type="button" size="lg" onClick={enterApp} data-testid="wizard-enter">
              Vào Trinity <ArrowRight aria-hidden />
            </Button>
          </section>
        ) : step ? (
          <>
            <ol className="flex flex-wrap gap-1.5" aria-label="Các bước">
              {steps.map((s, i) => (
                <li key={s.key} className={`h-2 w-10 rounded-full ${s.done || s.skipped ? "bg-emerald-500" : i === index ? "bg-primary" : "bg-muted-foreground/25"}`}>
                  <span className="sr-only">{`Bước ${i + 1}: ${STEP_TEXT[s.key].title}${s.done ? " (đã xong)" : ""}`}</span>
                </li>
              ))}
            </ol>
            <div className="space-y-2">
              <p className="text-sm font-medium text-primary">Bước {index + 1} trên {steps.length}</p>
              <h1 className="text-2xl font-semibold leading-tight" data-testid="wizard-step-title">{STEP_TEXT[step.key].title}</h1>
              <p className="text-sm text-muted-foreground">{STEP_TEXT[step.key].why}</p>
            </div>

            {!steps.some((s) => s.key === "ai") && index === 0 && (
              <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200" data-testid="wizard-ai-off">
                Máy chủ này chưa bật kết nối trợ lý AI nên chưa có bước nối AI. Người cài đặt máy chủ bật lại theo hướng dẫn cài đặt rồi triển khai lại.
              </p>
            )}

            {passed ? (
              <p className="flex items-start gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" data-testid="wizard-step-done">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
                {step.skipped ? "Bạn đã bỏ qua bước này." : step.key === "ai" ? "Trinity đã thấy trợ lý AI của bạn. Bước này đã xong." : "Công ty bạn đã làm xong bước này (có thể do đồng nghiệp làm)."}
              </p>
            ) : (
              <>
                {step.needs_admin && (
                  <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    Bước này cần quyền quản trị. Nếu bạn không làm được, hãy nhờ quản trị viên của công ty làm, xong thì bấm “Tôi đã làm xong”.
                  </p>
                )}
                <section className="rounded-2xl border bg-card p-4 sm:p-5">
                  <StepBody step={step.key} onGoChannels={() => goTo("channels")} />
                </section>
              </>
            )}

            {message && (
              <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100" data-testid="wizard-message">
                <b>Chưa qua được bước này.</b> {message}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <Button type="button" variant="outline" disabled={index === 0 || busy} onClick={() => goTo(steps[index - 1]?.key ?? null)} className="max-sm:h-11" data-testid="wizard-back">
                <ArrowLeft aria-hidden /> Quay lại
              </Button>
              <div className="flex flex-wrap gap-2">
                {step.can_skip && !passed && (
                  <Button type="button" variant="ghost" disabled={busy} onClick={() => handle("skip")} className="max-sm:h-11" data-testid="wizard-skip">
                    Bỏ qua bước này
                  </Button>
                )}
                {passed && !last ? (
                  <Button type="button" onClick={() => goTo(steps[index + 1].key)} className="max-sm:h-11" data-testid="wizard-next">
                    Tiếp tục <ArrowRight aria-hidden />
                  </Button>
                ) : (
                  <Button type="button" disabled={busy} onClick={() => handle("confirm")} className="max-sm:h-11" data-testid="wizard-confirm">
                    {busy && <Loader2 className="animate-spin" aria-hidden />} {passed ? "Hoàn tất" : "Tôi đã làm xong"}
                  </Button>
                )}
              </div>
            </div>
          </>
        ) : null}
      </main>
    </div>
  )
}
