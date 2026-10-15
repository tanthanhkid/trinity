"use client"

import { useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { GoogleColumnMapper } from "./google-column-mapper"
import { guessMapping, SCHEDULE_OPTIONS, type GoogleTargets, type InspectResult, type SyncDirection } from "./google-sheets-types"
import { OptionSelect } from "./option-select"
import type { SyncInput } from "./use-google-sheets"
import type { SimpleOption } from "./webhook-types"

interface Props {
  open: boolean
  onOpenChange: (o: boolean) => void
  targets: GoogleTargets | undefined
  sources: SimpleOption[]
  inspect: (v: { spreadsheet: string; tab?: string }) => Promise<InspectResult>
  inspecting: boolean
  pending: boolean
  error: string | null
  onSubmit: (v: SyncInput) => void
}

/** Thêm cấu hình đồng bộ: hướng → Sheet/tab → đích → ánh xạ cột → lịch. Form chỉ mount khi mở ⇒ mỗi lần mở là trạng thái sạch. */
export function GoogleSyncDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={(o) => (props.pending ? undefined : props.onOpenChange(o))}>
      {props.open && <GoogleSyncForm {...props} />}
    </Dialog>
  )
}

function GoogleSyncForm({ onOpenChange, targets, sources, inspect, inspecting, pending, error, onSubmit }: Props) {
  const [direction, setDirection] = useState<SyncDirection>("import")
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [newSheet, setNewSheet] = useState(false)
  const [info, setInfo] = useState<InspectResult | null>(null)
  const [tab, setTab] = useState("")
  const [target, setTarget] = useState("contact")
  const [map, setMap] = useState<Record<string, string>>({})
  const [dedupe, setDedupe] = useState("phone")
  const [sourceId, setSourceId] = useState("")
  const [schedule, setSchedule] = useState("")
  const [localError, setLocalError] = useState<string | null>(null)

  const fields = useMemo(() => {
    if (!targets) return []
    if (target === "contact") return targets.contact_fields
    return targets.custom_objects.find((o) => o.key === target)?.fields ?? []
  }, [targets, target])
  const headers = direction === "import" || !newSheet ? (info?.headers.length ? info.headers : null) : null
  const mappedKeys = fields.filter((f) => map[f.key]).map((f) => ({ value: f.key, label: f.label }))

  async function readSheet(nextTab?: string) {
    setLocalError(null)
    try {
      const r = await inspect({ spreadsheet: url, tab: nextTab ?? tab })
      setInfo(r)
      const t = nextTab ?? (r.tabs.includes(tab) ? tab : r.tabs[0] ?? "")
      setTab(t)
      if (t && !nextTab && t !== tab) { const again = await inspect({ spreadsheet: url, tab: t }); setInfo(again); setMap(guessMapping(fields, again.headers)) }
      else if (r.headers.length) setMap(guessMapping(fields, r.headers))
    } catch (e) {
      setLocalError((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Không đọc được Sheet")
    }
  }

  function submit() {
    if (!name.trim()) return setLocalError("Nhập tên cấu hình")
    if (!tab.trim()) return setLocalError("Chọn hoặc nhập tên tab")
    if (!newSheet && !url.trim()) return setLocalError("Dán URL Google Sheet")
    if (Object.keys(map).length === 0) return setLocalError("Ánh xạ ít nhất một cột")
    if (direction === "import" && target === "contact" && !map.phone) return setLocalError("Cần ánh xạ cột Số điện thoại")
    onSubmit({
      name: name.trim(), direction, sheet_title: tab.trim(), column_map: map,
      target_kind: target === "contact" ? "contact" : "custom_object",
      ...(target !== "contact" ? { target_object_key: target } : {}),
      ...(newSheet ? { create_sheet: true } : { spreadsheet: url.trim() }),
      ...(direction === "import" ? { dedupe_key: dedupe } : {}),
      ...(direction === "import" && target === "contact" && sourceId ? { contact_source_id: Number(sourceId) } : {}),
      schedule_minutes: schedule ? Number(schedule) : null,
    })
  }

  const targetOptions = [{ value: "contact", label: "Khách hàng" }, ...(targets?.custom_objects ?? []).map((o) => ({ value: o.key, label: o.label_plural }))]
  return (
    <>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Thêm đồng bộ Google Sheet</DialogTitle>
          <DialogDescription>Nhập dòng từ Sheet vào CRM (khử trùng theo SĐT/email) hoặc xuất dữ liệu mới của CRM ra Sheet.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="flex gap-2 max-sm:[&>button]:flex-1">
            {(["import", "export"] as const).map((d) => (
              <Button key={d} type="button" variant={direction === d ? "soft" : "outline"} aria-pressed={direction === d} onClick={() => { setDirection(d); setInfo(null); setMap({}) }}>
                {d === "import" ? "Nhập từ Sheet" : "Xuất ra Sheet"}
              </Button>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gs-name">Tên cấu hình</Label>
            <Input id="gs-name" className="max-sm:h-11" placeholder="Khách từ Sheet quảng cáo" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {direction === "export" && (
            <label className="flex items-center gap-2 text-sm max-sm:min-h-11">
              <Checkbox checked={newSheet} onCheckedChange={(v) => { setNewSheet(v === true); setInfo(null); setMap({}) }} /> Tạo Google Sheet mới
            </label>
          )}
          {!newSheet && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gs-url">URL Google Sheet</Label>
              <div className="flex gap-2">
                <Input id="gs-url" className="max-sm:h-11" placeholder="https://docs.google.com/spreadsheets/d/…" value={url} onChange={(e) => setUrl(e.target.value)} />
                <Button type="button" variant="outline" disabled={inspecting || !url.trim()} onClick={() => void readSheet()} className="max-sm:h-11">
                  {inspecting && <Loader2 className="mr-1 size-4 animate-spin" />}Đọc Sheet
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Tài khoản Google đã kết nối phải có quyền xem{direction === "export" ? "/sửa" : ""} Sheet này.</p>
            </div>
          )}
          {info && !newSheet ? (
            <OptionSelect label="Tab" value={tab} options={info.tabs.map((t) => ({ value: t, label: t }))} onChange={(t) => { setTab(t); void readSheet(t) }} className="h-9 w-full max-sm:h-11" />
          ) : newSheet ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gs-tab">Tên tab</Label>
              <Input id="gs-tab" className="max-sm:h-11" placeholder="Khách hàng" value={tab} onChange={(e) => setTab(e.target.value)} />
            </div>
          ) : null}
          <OptionSelect label={direction === "import" ? "Nhập vào" : "Xuất dữ liệu"} value={target} options={targetOptions} onChange={(v) => { setTarget(v); setMap({}); setDedupe(v === "contact" ? "phone" : "") }} className="h-9 w-full max-sm:h-11" />
          {(info || newSheet) && fields.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label>Ánh xạ cột</Label>
              <GoogleColumnMapper fields={fields} headers={headers} value={map} onChange={setMap} />
            </div>
          )}
          {direction === "import" && mappedKeys.length > 0 && (
            <OptionSelect label="Khử trùng theo" value={dedupe} options={target === "contact" ? mappedKeys.filter((k) => k.value === "phone" || k.value === "email") : mappedKeys} onChange={setDedupe} placeholder="Chọn trường" className="h-9 w-full max-sm:h-11" />
          )}
          {direction === "import" && target === "contact" && (
            <OptionSelect label="Nguồn khách (không bắt buộc)" value={sourceId} options={[{ value: "", label: "— Không gán —" }, ...sources.map((s) => ({ value: String(s.id), label: s.label }))]} onChange={setSourceId} placeholder="— Không gán —" className="h-9 w-full max-sm:h-11" />
          )}
          <OptionSelect label="Tự chạy" value={schedule} options={SCHEDULE_OPTIONS} onChange={setSchedule} className="h-9 w-full max-sm:h-11" />
          {(localError || error) && <p role="alert" className="text-sm text-red-600">{localError ?? error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending} className="max-sm:h-11">Huỷ</Button>
          <Button type="button" onClick={submit} disabled={pending} className="max-sm:h-11">
            {pending && <Loader2 className="mr-1 size-4 animate-spin" />}Tạo cấu hình
          </Button>
        </DialogFooter>
      </DialogContent>
    </>
  )
}
