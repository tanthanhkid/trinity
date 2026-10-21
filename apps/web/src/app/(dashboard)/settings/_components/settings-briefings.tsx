"use client"

import { Loader2, Play } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  useBriefingConfig,
  useRunBriefingNow,
  useUpdateBriefingConfig,
  type BriefingConfig,
  type BriefingSlot,
} from "@/hooks/use-briefings"
import { errorMessage } from "@/lib/error-messages"

type BoolKey = {
  [K in keyof BriefingConfig]: BriefingConfig[K] extends boolean ? K : never
}[keyof BriefingConfig]

interface Row {
  key: BoolKey
  label: string
  hint: string
}

const ROWS: Row[] = [
  { key: "in_app", label: "Thông báo trong ứng dụng", hint: "Hiện ở chuông thông báo, mở ra xem bản tin đầy đủ." },
]

/** Cài đặt › Bản tin sáng/chiều: bật/tắt, giờ gửi (giờ VN), kênh. Trinity không tự chạy AI. Quyền `settings.integrations`. */
export function SettingsBriefings() {
  const { data, isLoading, isError } = useBriefingConfig()
  const update = useUpdateBriefingConfig()
  const runNow = useRunBriefingNow()

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Đang tải cấu hình...
      </div>
    )
  }
  if (isError || !data) return <p className="text-sm text-destructive">Không tải được cấu hình bản tin.</p>

  const { config, available } = data
  const save = (patch: Partial<BriefingConfig>) =>
    update.mutate(patch, {
      onSuccess: () => toast.success("Đã lưu cấu hình bản tin"),
      onError: (err) => toast.error(errorMessage(err, "Không lưu được, vui lòng thử lại")),
    })
  const send = (slot: BriefingSlot) =>
    runNow.mutate(slot, {
      onSuccess: (r) => toast.success(`Đã gửi ${r.created} bản tin (${r.recipients} người nhận)`),
      onError: (err) => toast.error(errorMessage(err, "Không gửi được bản tin")),
    })

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Mỗi sáng và chiều hệ thống tự tổng hợp số liệu rồi gửi cho người có quyền xem Báo cáo Tổng quan.
        Giám đốc/quản trị thấy số liệu cả công ty, trưởng nhóm chỉ thấy số liệu của nhóm mình.
      </p>
      <p className="text-sm text-muted-foreground">
        Bản tin tự động là bản mẫu dựng từ số liệu. Muốn bản tin do AI viết, hãy kết nối ChatGPT/Claude/agent khác của bạn
        (Cài đặt › Kết nối &amp; AI) rồi giao việc định kỳ: agent đọc dữ liệu bằng công cụ <code>get_briefing_data</code> và lưu bằng <code>save_briefing</code>.
      </p>
      {!available.feature && (
        <p className="text-sm text-amber-600">Tính năng “Bản tin” đang bị tắt ở gói của công ty — bản tin sẽ không chạy.</p>
      )}
      <Card className="rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
        <CardContent className="divide-y p-0">
          <Line title="Bật bản tin tự động" hint="Tắt = không gửi gì cả. Mặc định tắt.">
            <Switch checked={config.enabled} disabled={update.isPending} onCheckedChange={(v) => save({ enabled: v })} aria-label="Bật bản tin tự động" />
          </Line>
          <SlotLine
            title="Bản tin sáng"
            on={config.morning_enabled}
            time={config.morning_time}
            disabled={update.isPending}
            onToggle={(v) => save({ morning_enabled: v })}
            onTime={(t) => save({ morning_time: t })}
          />
          <SlotLine
            title="Bản tin chiều"
            on={config.evening_enabled}
            time={config.evening_time}
            disabled={update.isPending}
            onToggle={(v) => save({ evening_enabled: v })}
            onTime={(t) => save({ evening_time: t })}
          />
          {ROWS.map((r) => (
            <Line key={r.key} title={r.label} hint={r.hint}>
              <Switch checked={config[r.key]} disabled={update.isPending} onCheckedChange={(v) => save({ [r.key]: v })} aria-label={r.label} />
            </Line>
          ))}
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={runNow.isPending} onClick={() => send("morning")}>
          <Play className="size-4" /> Gửi thử bản tin sáng ngay
        </Button>
        <Button variant="outline" disabled={runNow.isPending} onClick={() => send("evening")}>
          <Play className="size-4" /> Gửi thử bản tin chiều ngay
        </Button>
        <p className="text-xs text-muted-foreground">Mỗi người chỉ nhận 1 bản tin mỗi buổi mỗi ngày; gửi thử không gửi trùng.</p>
      </div>
    </div>
  )
}

function Line({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4 max-sm:min-h-14">
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {children}
    </div>
  )
}

function SlotLine(p: {
  title: string
  on: boolean
  time: string
  disabled: boolean
  onToggle: (v: boolean) => void
  onTime: (t: string) => void
}) {
  return (
    <Line title={p.title} hint="Giờ gửi theo giờ Việt Nam.">
      <div className="flex items-center gap-3">
        <Input
          type="time"
          defaultValue={p.time}
          key={p.time}
          disabled={p.disabled || !p.on}
          className="w-28"
          aria-label={`Giờ gửi ${p.title}`}
          onBlur={(e) => e.target.value && e.target.value !== p.time && p.onTime(e.target.value)}
        />
        <Switch checked={p.on} disabled={p.disabled} onCheckedChange={p.onToggle} aria-label={p.title} />
      </div>
    </Line>
  )
}
