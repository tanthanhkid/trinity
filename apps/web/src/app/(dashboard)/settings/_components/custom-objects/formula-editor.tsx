"use client"

import { useMemo, useState } from "react"
import { Calculator, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { VnDateInput } from "@/components/ui/vn-date-input"
import { useFormulaPreview } from "@/hooks/custom-objects/use-custom-objects"
import { FORMULA_REF_TYPES } from "@/lib/custom-objects/field-meta"
import { formatNumberVn } from "@/lib/custom-objects/format-value"
import type { CustomFieldDef } from "@/types/custom-objects"

const REF_RE = /\{([a-z][a-z0-9_]*)\}/g
const FUNCS = ["round(x, 2)", "months_between({bat_dau}, {ket_thuc})", "days_between({bat_dau}, {ket_thuc})"]

/**
 * Soạn biểu thức cho trường “Công thức”: + − × ÷, ngoặc, số, `{khoá_trường}`, `round(x,n)`,
 * `months_between(d1,d2)`, `days_between(d1,d2)`. KHÔNG chạy mã — BE tự phân tích và tính. “% ” được đọc ra phân số
 * (5% → 0,05). Có ô “Tính thử” dùng chính bộ phân tích của BE.
 */
export function FormulaEditor({ objectKey, fields, editingKey, expression, onChange }: {
  objectKey: string
  fields: CustomFieldDef[]
  editingKey?: string
  expression: string
  onChange: (v: string) => void
}) {
  const refable = fields.filter((f) => f.key !== editingKey && FORMULA_REF_TYPES.includes(f.type))
  const preview = useFormulaPreview()
  const [sample, setSample] = useState<Record<string, unknown>>({})
  const used = useMemo(() => [...new Set([...expression.matchAll(REF_RE)].map((m) => m[1]))], [expression])

  function insert(text: string) {
    onChange(expression ? `${expression}${/[\s(]$/.test(expression) ? "" : " "}${text}` : text)
  }

  return (
    <div className="space-y-3">
      <Textarea value={expression} onChange={(e) => onChange(e.target.value)} rows={2} maxLength={300} spellCheck={false}
        className="font-mono text-sm" placeholder="{gia_goc} * (1 - {uu_dai})" aria-label="Biểu thức công thức" />
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Bấm để chèn trường</p>
        <div className="flex flex-wrap gap-1.5">
          {refable.length === 0 && <span className="text-xs text-muted-foreground">Chưa có trường số / tiền / % / ngày để tham chiếu — hãy thêm trước.</span>}
          {refable.map((f) => (
            <Button key={f.key} type="button" size="sm" variant="outline" onClick={() => insert(`{${f.key}}`)} title={f.key}>{f.label}</Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FUNCS.map((fn) => <Button key={fn} type="button" size="sm" variant="ghost" className="font-mono" onClick={() => insert(fn)}>{fn.split("(")[0]}()</Button>)}
        </div>
      </div>
      {used.length > 0 && (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-xs font-medium text-muted-foreground">Tính thử với giá trị mẫu</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {used.map((k) => {
              const f = fields.find((x) => x.key === k)
              if (!f) return <p key={k} className="text-xs text-destructive">Không có trường “{k}”</p>
              const isDate = f.type === "date" || f.type === "datetime"
              return (
                <label key={k} className="space-y-1 text-xs">
                  <span className="font-medium">{f.label}{f.type === "percent" ? " (%)" : ""}</span>
                  {isDate
                    ? <VnDateInput value={(sample[k] as string) ?? ""} onChange={(v) => setSample((s) => ({ ...s, [k]: v || undefined }))} />
                    : <Input type="number" step="any" inputMode="decimal" value={typeof sample[k] === "number" ? (sample[k] as number) : ""} onChange={(e) => setSample((s) => ({ ...s, [k]: e.target.value === "" ? undefined : Number(e.target.value) }))} />}
                </label>
              )
            })}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" variant="outline" disabled={preview.isPending || !expression.trim()}
              onClick={() => preview.mutate({ object_key: objectKey, expression, sample, editing_key: editingKey })}>
              {preview.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Calculator className="mr-1.5 size-3.5" />} Tính thử
            </Button>
            {preview.data?.ok === true && <span className="text-sm font-medium">= {preview.data.result === null ? "— (thiếu dữ liệu hoặc chia cho 0)" : formatNumberVn(preview.data.result)}</span>}
            {preview.data?.ok === false && <span role="alert" className="text-sm text-destructive">{preview.data.error}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
