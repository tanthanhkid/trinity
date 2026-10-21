"use client"

import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import apiClient from "@/lib/api-client"
import { useOrgFeature } from "@/hooks/use-org-features"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/error-messages"

interface LeadRules {
  thresholds: { hot: number; warm: number }
  ai_intent: { enabled: boolean; max_points: number }
  [k: string]: unknown
}
interface RulesPayload { rules: LeadRules; defaults: LeadRules; job_enabled: boolean }
interface StaleConfig { contact_days: number; deal_days: number; reminder_grace_hours: number; digest_hour: number }
interface StalePayload { config: StaleConfig; job_enabled: boolean }

const RULES_KEY = ["lead-scoring", "rules"] as const
const STALE_KEY = ["stale-work", "config"] as const

function NumField({ id, label, value, onChange, hint }: { id: string; label: string; value: number; onChange: (n: number) => void; hint?: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</Label>
      <Input id={id} type="number" min={0} value={Number.isFinite(value) ? value : 0} onChange={(e) => onChange(Number(e.target.value))} className="w-full sm:w-32" />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/**
 * Cài đặt > Trợ lý bán hàng: quy tắc chấm điểm lead nóng + ngưỡng nhắc việc treo.
 * Chỉ hiện với quyền `contacts.catalog` (cùng quyền BE `PUT /lead-scoring/rules`, `PUT /stale-work/config`).
 */
export function SettingsSalesAssistant() {
  const qc = useQueryClient()
  // Từng thẻ theo cờ tổ chức/gói riêng của nó: `lead_scoring`, `stale_reminders`.
  const scoringOn = useOrgFeature("lead_scoring")
  const staleOn = useOrgFeature("stale_reminders")
  const rulesQ = useQuery({ queryKey: RULES_KEY, enabled: scoringOn, queryFn: async () => (await apiClient.get<RulesPayload>("/lead-scoring/rules")).data })
  const staleQ = useQuery({ queryKey: STALE_KEY, enabled: staleOn, queryFn: async () => (await apiClient.get<StalePayload>("/stale-work/config")).data })

  const [rules, setRules] = useState<LeadRules | null>(null)
  const [json, setJson] = useState("")
  const [stale, setStale] = useState<StaleConfig | null>(null)

  useEffect(() => {
    if (rulesQ.data) { setRules(rulesQ.data.rules); setJson(JSON.stringify(rulesQ.data.rules, null, 2)) }
  }, [rulesQ.data])
  useEffect(() => { if (staleQ.data) setStale(staleQ.data.config) }, [staleQ.data])

  const saveRules = useMutation({
    mutationFn: async (body: LeadRules) => (await apiClient.put<{ rules: LeadRules }>("/lead-scoring/rules", body)).data,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: RULES_KEY }); toast.success("Đã lưu quy tắc chấm điểm") },
    onError: (err) => toast.error(errorMessage(err, "Không lưu được quy tắc")),
  })
  const saveStale = useMutation({
    mutationFn: async (body: StaleConfig) => (await apiClient.put("/stale-work/config", body)).data,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: STALE_KEY }); toast.success("Đã lưu cấu hình nhắc việc treo") },
    onError: (err) => toast.error(errorMessage(err, "Không lưu được cấu hình")),
  })
  const rescore = useMutation({
    mutationFn: async () => (await apiClient.post<{ rescored: number }>("/lead-scoring/recompute-all")).data,
    onSuccess: (d) => toast.success(`Đã chấm lại ${d.rescored} khách`),
    onError: (err) => toast.error(errorMessage(err, "Không chấm lại được")),
  })
  const runDigest = useMutation({
    mutationFn: async () => (await apiClient.post<{ sent: number }>("/stale-work/run")).data,
    onSuccess: (d) => toast.success(`Đã gửi nhắc việc cho ${d.sent} người`),
    onError: (err) => toast.error(errorMessage(err, "Không gửi được nhắc việc")),
  })

  if (!scoringOn && !staleOn) {
    return <p className="text-sm text-muted-foreground">Chấm điểm lead và nhắc việc treo chưa bật hoặc không có trong gói hiện tại của tổ chức này.</p>
  }
  if ((scoringOn && rulesQ.isError) || (staleOn && staleQ.isError)) {
    return (
      <div className="flex items-center gap-3 text-sm text-destructive" role="alert">
        Không tải được cấu hình trợ lý bán hàng.
        <Button type="button" variant="outline" size="sm" onClick={() => { void (scoringOn && rulesQ.isError ? rulesQ.refetch() : undefined); void (staleOn && staleQ.isError ? staleQ.refetch() : undefined) }}>
          Thử lại
        </Button>
      </div>
    )
  }
  if ((scoringOn && (rulesQ.isLoading || !rules)) || (staleOn && (staleQ.isLoading || !stale))) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải...</div>
  }

  // Giữ ô JSON đồng bộ với các ô nhập: sửa một nơi, nút lưu ở nơi kia không ghi đè bằng bản cũ.
  const editRules = (r: LeadRules) => { setRules(r); setJson(JSON.stringify(r, null, 2)) }

  const applyJson = () => {
    try { saveRules.mutate(JSON.parse(json) as LeadRules) } catch { toast.error("JSON quy tắc không hợp lệ") }
  }

  return (
    <div className="space-y-4">
      {scoringOn && rules && (
      <Card className="rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
        <CardHeader><CardTitle>Chấm điểm lead nóng</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {rulesQ.data && !rulesQ.data.job_enabled ? (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">Job tự chấm điểm đang TẮT trên máy chủ (đặt LEAD_SCORING_ENABLED=true để bật). Vẫn dùng được nút “Chấm lại” bên dưới.</p>
          ) : null}
          <p className="text-sm text-muted-foreground">Điểm 0–100 từ độ mới liên hệ, số lần tương tác, giai đoạn, phản hồi gần nhất, nguồn và hồ sơ (SĐT/nhu cầu). Từ ngưỡng “Nóng” trở lên là Nóng, từ ngưỡng “Ấm” là Ấm, còn lại là Lạnh.</p>
          <div className="flex flex-wrap gap-4">
            <NumField id="th-hot" label="Ngưỡng Nóng (từ điểm)" value={rules.thresholds.hot} onChange={(n) => editRules({ ...rules, thresholds: { ...rules.thresholds, hot: n } })} />
            <NumField id="th-warm" label="Ngưỡng Ấm (từ điểm)" value={rules.thresholds.warm} onChange={(n) => editRules({ ...rules, thresholds: { ...rules.thresholds, warm: n } })} />
          </div>
          <div className="flex items-center gap-3">
            <Switch checked={rules.ai_intent.enabled} onCheckedChange={(v) => editRules({ ...rules, ai_intent: { ...rules.ai_intent, enabled: v } })} aria-label="Cộng điểm ý định do agent AI chấm" />
            <div>
              <p className="text-sm font-medium">Cộng điểm ý định mua do agent AI của bạn chấm</p>
              <p className="text-xs text-muted-foreground">Trinity không tự chạy AI. Agent của bạn (ChatGPT/Claude… đã kết nối với Trinity) đọc ghi chú bằng <code>list_leads_to_score</code> và ghi điểm bằng <code>set_lead_intent</code>; điểm đó cộng tối đa {rules.ai_intent.max_points} điểm.</p>
            </div>
          </div>
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm font-medium">Quy tắc chi tiết (JSON)</summary>
            <Textarea value={json} onChange={(e) => setJson(e.target.value)} rows={14} className="mt-2 font-mono text-xs" aria-label="Quy tắc chấm điểm dạng JSON" />
            <Button className="mt-2" variant="outline" size="sm" onClick={applyJson} disabled={saveRules.isPending}>Lưu từ JSON</Button>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => saveRules.mutate(rules)} disabled={saveRules.isPending}>Lưu quy tắc</Button>
            <Button variant="outline" onClick={() => rescore.mutate()} disabled={rescore.isPending}>Chấm lại khách chưa chấm / điểm cũ</Button>
          </div>
        </CardContent>
      </Card>
      )}

      {staleOn && stale && (
      <Card className="rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
        <CardHeader><CardTitle>Nhắc việc treo</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {staleQ.data && !staleQ.data.job_enabled ? (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">Job gửi tổng hợp sáng đang TẮT trên máy chủ (đặt STALE_REMINDERS_ENABLED=true để bật).</p>
          ) : null}
          <p className="text-sm text-muted-foreground">Mỗi sáng gửi thông báo cho người phụ trách và trưởng nhóm: khách/deal im lặng quá N ngày, việc quá hạn, lịch hẹn nhắc bị lỡ. Sale chỉ nhận việc của mình; trưởng nhóm nhận thêm của cấp dưới.</p>
          <div className="flex flex-wrap gap-4">
            <NumField id="st-contact" label="Khách im lặng quá (ngày)" value={stale.contact_days} onChange={(n) => setStale({ ...stale, contact_days: n })} />
            <NumField id="st-deal" label="Deal đứng yên quá (ngày)" value={stale.deal_days} onChange={(n) => setStale({ ...stale, deal_days: n })} />
            <NumField id="st-grace" label="Lịch hẹn nhắc coi là lỡ sau (giờ)" value={stale.reminder_grace_hours} onChange={(n) => setStale({ ...stale, reminder_grace_hours: n })} />
            <NumField id="st-hour" label="Giờ gửi tổng hợp (0–23, giờ VN)" value={stale.digest_hour} onChange={(n) => setStale({ ...stale, digest_hour: n })} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => saveStale.mutate(stale)} disabled={saveStale.isPending}>Lưu cấu hình</Button>
            <Button variant="outline" onClick={() => runDigest.mutate()} disabled={runDigest.isPending}>Gửi tổng hợp ngay</Button>
          </div>
        </CardContent>
      </Card>
      )}
    </div>
  )
}
