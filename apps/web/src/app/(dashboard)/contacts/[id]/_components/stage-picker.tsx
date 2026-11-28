"use client"

import { StageChip, type StageTone } from "@/components/ui/stage-chip"
import { cn } from "@/lib/utils"
import { useSettingsOptions } from "@/hooks/use-settings-options"
import { usePermissions } from "@/lib/rbac"
import { useContactPatch } from "./use-contact-patch"
import type { ContactData } from "./contact-info-form"

/** Mã bền của `contact_stage` → tông của hệ «Ánh xanh». Mã khác (bước tuỳ biến) dùng tông trung tính. */
const TONE_BY_VALUE: Record<string, StageTone> = {
  new: "new",
  follow_up_2: "consult",
  follow_up_3: "quote",
}

export function stageTone(value: string | null | undefined): StageTone {
  return (value && TONE_BY_VALUE[value]) || "neutral"
}

/**
 * Chọn giai đoạn của khách: chọn là lưu ngay + toast Hoàn tác. Chỉ người có `contacts.update` đổi được;
 * người khác chỉ thấy giai đoạn hiện tại. `layout="list"` (desktop, cột trái) / `"chips"` (điện thoại, cuộn ngang).
 */
export function StagePicker({ contact, layout }: { contact: ContactData; layout: "list" | "chips" }) {
  const { data: stages = [] } = useSettingsOptions("contact_stage")
  const { can } = usePermissions()
  const patch = useContactPatch(contact.id)
  const editable = can("contacts.update")
  const current = contact.stage_id

  const pick = (id: number, label: string) => {
    if (id === current) return
    void patch(`Chuyển sang “${label}”`, { stage_id: id }, current ? { stage_id: current } : null)
  }

  if (stages.length === 0) return null

  if (layout === "chips") {
    return (
      <div role="radiogroup" aria-label="Giai đoạn" className="flex gap-2 overflow-x-auto px-5 pb-3.5 [scrollbar-width:none]">
        {stages.map((o) => (
          <StageChip
            key={o.id}
            tone={stageTone(o.value)}
            size="md"
            selected={o.id === current}
            onClick={editable ? () => pick(o.id, o.label) : undefined}
            role="radio"
            aria-checked={o.id === current}
            className="h-11 shrink-0 px-4 text-[15px] font-semibold whitespace-nowrap"
          >
            {o.label}
          </StageChip>
        ))}
      </div>
    )
  }

  return (
    <div role="radiogroup" aria-label="Giai đoạn" className="flex flex-col gap-1">
      {stages.map((o) => {
        const checked = o.id === current
        const tone = stageTone(o.value)
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={!editable}
            onClick={() => pick(o.id, o.label)}
            className={cn(
              "flex h-10 items-center gap-2.5 rounded-ax-field px-3 text-left text-sm outline-none transition-colors focus-visible:shadow-[var(--ax-focus-ring)] disabled:cursor-default",
              checked ? "font-semibold" : "font-medium text-ax-ink-2 hover:bg-ax-hover",
            )}
            style={checked ? { background: `var(--ax-stage-${tone === "neutral" ? "care" : tone}-bg)`, color: `var(--ax-stage-${tone === "neutral" ? "care" : tone}-ink)` } : undefined}
          >
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: tone === "neutral" ? "var(--ax-ink-3)" : `var(--ax-stage-${tone}-dot)`, boxShadow: "0 0 0 3px var(--ax-sunken)" }}
            />
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
