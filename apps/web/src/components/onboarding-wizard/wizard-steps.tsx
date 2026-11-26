"use client"

import { useState, type ReactNode } from "react"
import { Briefcase, Building2, GraduationCap, Loader2, Stethoscope, Store, type LucideIcon } from "lucide-react"
import {
  INDUSTRY_KEYS,
  INDUSTRY_PRESETS,
  LOCKED_FEATURES,
  ORG_FEATURES,
  ORG_FEATURE_GROUPS,
  ORG_FEATURE_KEYS,
  type IndustryKey,
  type OrgFeatureKey,
} from "@trinity/rbac"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import apiClient, { getApiErrorMessage } from "@/lib/api-client"
import { useSettingsOptions } from "@/hooks/use-settings-options"
import { SocialChannels } from "@/app/(dashboard)/social/_components/social-channels"
import { SocialComposer } from "@/app/(dashboard)/social/_components/social-composer"
import { cn } from "@/lib/utils"
import type { WizardStepKey } from "@/hooks/use-onboarding-wizard"

const ICONS: Record<string, LucideIcon> = { GraduationCap, Store, Stethoscope, Building2, Briefcase }

/** Bước 1: chọn loại doanh nghiệp (4 mẫu có sẵn + Khác). */
function StepIndustry({ industry, onSelect, built }: { industry: IndustryKey | null; onSelect: (k: IndustryKey) => void; built: boolean }) {
  return (
    <div className="space-y-3" data-testid="step-industry">
      <div role="radiogroup" aria-label="Loại doanh nghiệp" className="grid gap-3 sm:grid-cols-2">
        {INDUSTRY_KEYS.map((key) => {
          const p = INDUSTRY_PRESETS[key]
          const Icon = ICONS[p.icon] ?? Briefcase
          const on = industry === key
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={built}
              onClick={() => onSelect(key)}
              data-testid={`industry-${key}`}
              className={cn(
                "flex min-h-24 items-start gap-3 rounded-2xl border bg-background p-4 text-left transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-70",
                on && "border-primary bg-accent/50 ring-2 ring-primary/40",
              )}
            >
              <Icon className="mt-0.5 size-6 shrink-0 text-primary" aria-hidden />
              <span className="min-w-0">
                <span className="block font-medium">{p.label}</span>
                <span className="block text-sm text-muted-foreground">{p.description}</span>
              </span>
            </button>
          )
        })}
      </div>
      {built && <p className="text-sm text-muted-foreground">Hệ thống đã được dựng nên không đổi loại doanh nghiệp ở đây được. Muốn thêm bảng riêng, vào Cài đặt sau.</p>}
    </div>
  )
}

/** Bước 2: chọn phân hệ (tick sẵn theo ngành), bộ cơ bản luôn bật. */
function StepModules({ industry, features, onChange, built }: { industry: IndustryKey | null; features: OrgFeatureKey[]; onChange: (f: OrgFeatureKey[]) => void; built: boolean }) {
  const preset = industry ? INDUSTRY_PRESETS[industry] : null
  const toggle = (key: OrgFeatureKey, next: boolean) => onChange(next ? [...new Set([...features, key])] : features.filter((k) => k !== key))
  return (
    <div className="space-y-4" data-testid="step-modules">
      {preset && (
        <p className="rounded-lg bg-muted p-3 text-sm">
          <b>{preset.label}.</b> Đã tick sẵn các phân hệ hay dùng. Bạn thêm hoặc bớt tuỳ ý; sau này đổi lại ở Cài đặt › Tính năng.
          {preset.template ? " Khi dựng, Trinity tạo luôn các danh sách của ngành này kèm vài dòng dữ liệu mẫu." : " Khi dựng, Trinity tạo sẵn vài khách hàng mẫu."}{" "}
          Dữ liệu mẫu tự mất khi bạn thêm khách hoặc dòng dữ liệu thật đầu tiên.
        </p>
      )}
      {ORG_FEATURE_GROUPS.map((group) => {
        const keys = ORG_FEATURE_KEYS.filter((k) => ORG_FEATURES[k].group === group.key)
        return (
          <section key={group.key} aria-labelledby={`wiz-group-${group.key}`} className="space-y-2">
            <h3 id={`wiz-group-${group.key}`} className="text-sm font-semibold">{group.label}</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {keys.map((key) => {
                const locked = (LOCKED_FEATURES as readonly string[]).includes(key)
                const on = locked || features.includes(key)
                return (
                  <label
                    key={key}
                    htmlFor={`wiz-feature-${key}`}
                    className={cn("flex min-h-14 cursor-pointer items-start justify-between gap-3 rounded-xl border p-3", on && "border-primary/40 bg-accent/30", (built || locked) && "cursor-default")}
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {ORG_FEATURES[key].label}
                        {locked && <span className="ml-2 rounded-full bg-muted px-2 py-0.5 align-middle text-[11px] font-normal text-muted-foreground">Cơ bản</span>}
                      </span>
                      <span className="block text-xs text-muted-foreground">{ORG_FEATURES[key].description}</span>
                    </span>
                    <Switch id={`wiz-feature-${key}`} checked={on} disabled={locked || built} onCheckedChange={(v) => toggle(key, v)} />
                  </label>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

/** Bước 3: thêm khách đầu tiên bằng form ngắn (không cần AI). */
function StepData({ canSkip }: { canSkip: boolean }) {
  const sources = useSettingsOptions("contact_source")
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const source = sources.data?.find((o) => o.value === "other") ?? sources.data?.[0]

  const submit = async () => {
    setError(null)
    if (!/^(0|\+84)\d{9}$/.test(phone.trim())) return setError("Số điện thoại cần bắt đầu bằng 0 hoặc +84 và có 10 chữ số.")
    if (!source) return setError("Chưa tải được danh sách nguồn khách, bạn thử lại sau ít giây.")
    setBusy(true)
    try {
      await apiClient.post("/contacts", { phone: phone.trim(), full_name: name.trim() || undefined, source_id: source.id })
      setAdded(name.trim() || phone.trim())
      setName("")
      setPhone("")
    } catch (err) {
      setError(getApiErrorMessage(err, "Chưa thêm được khách, bạn thử lại."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4" data-testid="step-data">
      <p className="text-sm">
        Trinity đang có vài dòng <b>dữ liệu mẫu</b> để bạn xem thử. Thêm khách hàng thật đầu tiên, dữ liệu mẫu sẽ tự biến mất.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="wiz-contact-name">Tên khách</Label>
          <Input id="wiz-contact-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ví dụ: Nguyễn Văn An" autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wiz-contact-phone">Số điện thoại</Label>
          <Input id="wiz-contact-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0912345678" inputMode="tel" autoComplete="off" />
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {added && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" data-testid="contact-added">Đã thêm “{added}”. Bấm “Tôi đã làm xong” để đi tiếp.</p>}
      <Button type="button" onClick={submit} disabled={busy || !phone.trim()} data-testid="add-contact">
        {busy && <Loader2 className="animate-spin" aria-hidden />} Thêm khách
      </Button>
      {canSkip && <p className="text-sm text-muted-foreground">Có sẵn danh sách trong Excel hoặc Google Sheet? Bấm “Bỏ qua bước này”, vào Trinity rồi nhập ở Cài đặt › Kết nối &amp; AI › Google Sheets.</p>}
    </div>
  )
}

function StepChannels() {
  return (
    <div className="space-y-4">
      <p className="text-sm">Bấm <b>Liên kết</b> ở Facebook (Fanpage) hoặc YouTube, đăng nhập và đồng ý trên trang của Facebook/Google. Xong sẽ quay lại đây, kênh hiện <b>Hoạt động</b>.</p>
      <SocialChannels />
    </div>
  )
}

function StepPost({ onGoChannels }: { onGoChannels: () => void }) {
  const [sent, setSent] = useState(false)
  return (
    <div className="space-y-4">
      <p className="text-sm">Soạn một bài, chọn kênh rồi bấm <b>Đăng ngay</b>. Bài sẽ lên kênh thật của công ty, nên viết nội dung bạn muốn khách thấy.</p>
      {sent && <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" role="status">Đã gửi bài đi đăng. Chờ khoảng nửa phút rồi bấm “Tôi đã làm xong”.</p>}
      <SocialComposer onCreated={() => setSent(true)} onGoChannels={onGoChannels} />
    </div>
  )
}

export const STEP_TEXT: Record<WizardStepKey, { title: string; why: string }> = {
  industry: {
    title: "Công ty bạn làm nghề gì?",
    why: "Chọn loại doanh nghiệp gần nhất, Trinity dựng sẵn các danh sách và màn hình hợp với nghề đó. Không có loại nào hợp thì chọn Khác.",
  },
  modules: {
    title: "Chọn các chức năng bạn muốn dùng",
    why: "Chức năng nào bật thì hiện ở menu, chức năng nào tắt thì ẩn cho gọn. Bấm Dựng hệ thống là xong, bạn đổi lại được bất cứ lúc nào.",
  },
  data: {
    title: "Thêm khách hàng đầu tiên",
    why: "Đưa một khách thật vào để bắt đầu theo dõi. Dữ liệu mẫu sẽ tự mất khi bạn thêm khách hoặc dòng dữ liệu thật đầu tiên.",
  },
  channels: {
    title: "Kết nối Fanpage hoặc kênh YouTube",
    why: "Nối kênh của công ty để đăng bài từ Trinity và để khách nhắn Fanpage tự thành khách hàng.",
  },
  post: {
    title: "Đăng bài đầu tiên",
    why: "Thử đăng một bài lên kênh vừa nối để chắc mọi thứ chạy đúng.",
  },
}

export interface StepContext {
  industry: IndustryKey | null
  onIndustry: (k: IndustryKey) => void
  features: OrgFeatureKey[]
  onFeatures: (f: OrgFeatureKey[]) => void
  /** Công ty đã dựng rồi (không đổi ngành/phân hệ ở đây nữa). */
  built: boolean
  /** Máy chủ cho phép bỏ qua bước đang xem. */
  canSkip: boolean
}

export function StepBody({ step, onGoChannels, ctx }: { step: WizardStepKey; onGoChannels: () => void; ctx: StepContext }): ReactNode {
  switch (step) {
    case "industry":
      return <StepIndustry industry={ctx.industry} onSelect={ctx.onIndustry} built={ctx.built} />
    case "modules":
      return <StepModules industry={ctx.industry} features={ctx.features} onChange={ctx.onFeatures} built={ctx.built} />
    case "data":
      return <StepData canSkip={ctx.canSkip} />
    case "channels":
      return <StepChannels />
    case "post":
      return <StepPost onGoChannels={onGoChannels} />
  }
}
