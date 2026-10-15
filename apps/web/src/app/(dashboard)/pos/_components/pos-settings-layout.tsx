"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { usePosAreas, usePosConfigMutation, usePosModifiers, usePosTables } from "@/hooks/pos/use-pos"
import { parseMoney, posErrorMessage, vnd } from "@/lib/pos-format"
import { cn } from "@/lib/utils"

const done = (msg: string) => ({ onSuccess: () => toast.success(msg), onError: (e: unknown) => toast.error(posErrorMessage(e)) })

/** Khu vực + bàn: thêm khu vực, thêm bàn vào khu vực, bật/tắt. */
export function PosSettingsAreas() {
  const areas = usePosAreas().data ?? []
  const tables = usePosTables().data ?? []
  const cfg = usePosConfigMutation(["areas", "tables"])
  const [areaName, setAreaName] = useState("")
  const [tableNames, setTableNames] = useState<Record<number, string>>({})
  return (
    <section className="space-y-3 rounded-[var(--radius)] border bg-card p-4" aria-label="Khu vực và bàn">
      <h2 className="text-base font-bold text-foreground">Khu vực &amp; bàn</h2>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!areaName.trim()) return
        cfg.mutate({ method: "post", url: "/pos/areas", body: { name: areaName.trim() } }, { ...done("Đã thêm khu vực"), onSuccess: () => { setAreaName(""); toast.success("Đã thêm khu vực") } }) }}>
        <Input value={areaName} onChange={(e) => setAreaName(e.target.value)} placeholder="Tên khu vực (Tầng 1, Sân vườn…)" aria-label="Tên khu vực mới" className="h-11" />
        <Button type="submit" variant="outline" className="min-h-11" disabled={cfg.isPending}>Thêm khu vực</Button>
      </form>
      {areas.map((a) => (
        <div key={a.id} className="space-y-2 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className={cn("text-sm font-semibold", !a.is_active && "text-muted-foreground line-through")}>{a.name}</h3>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => cfg.mutate({ method: "patch", url: `/pos/areas/${a.id}`, body: { is_active: !a.is_active } }, done("Đã cập nhật"))}>{a.is_active ? "Tắt" : "Bật"}</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {tables.filter((t) => t.area_id === a.id).map((t) => (
              <button key={t.id} type="button" aria-pressed={t.is_active} title={t.is_active ? "Bấm để tắt bàn" : "Bấm để bật bàn"}
                onClick={() => cfg.mutate({ method: "patch", url: `/pos/tables/${t.id}`, body: { is_active: !t.is_active } }, done("Đã cập nhật bàn"))}
                className={cn("min-h-11 min-w-14 rounded-lg border px-3 text-sm font-semibold", t.is_active ? "bg-background text-foreground" : "bg-muted text-muted-foreground line-through")}>
                {t.name}
              </button>
            ))}
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const name = (tableNames[a.id] ?? "").trim(); if (!name) return
            cfg.mutate({ method: "post", url: "/pos/tables", body: { area_id: a.id, name } }, { onSuccess: () => { setTableNames((s) => ({ ...s, [a.id]: "" })); toast.success("Đã thêm bàn") }, onError: (er) => toast.error(posErrorMessage(er)) }) }}>
            <Input value={tableNames[a.id] ?? ""} onChange={(e) => setTableNames((s) => ({ ...s, [a.id]: e.target.value }))} placeholder="Tên bàn (B1, B2…)" aria-label={`Tên bàn mới trong ${a.name}`} className="h-11" />
            <Button type="submit" variant="outline" className="min-h-11">Thêm bàn</Button>
          </form>
        </div>
      ))}
    </section>
  )
}

/** Tuỳ chọn sản phẩm (Size, Màu, Kiểu…) — dùng chung cho mọi sản phẩm; giá cộng thêm có thể âm. */
export function PosSettingsModifiers() {
  const mods = usePosModifiers(true).data ?? []
  const cfg = usePosConfigMutation(["modifiers"])
  const [group, setGroup] = useState("")
  const [name, setName] = useState("")
  const [delta, setDelta] = useState("")
  const reset = () => { setName(""); setDelta("") }
  return (
    <section className="space-y-3 rounded-[var(--radius)] border bg-card p-4" aria-label="Tuỳ chọn món">
      <h2 className="text-base font-bold text-foreground">Tuỳ chọn món</h2>
      <form className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault()
        if (!group.trim() || !name.trim()) return
        const price_delta = delta.trim().startsWith("-") ? -(parseMoney(delta) ?? 0) : parseMoney(delta) ?? 0
        cfg.mutate({ method: "post", url: "/pos/modifiers", body: { group_name: group.trim(), name: name.trim(), price_delta } }, { onSuccess: () => { reset(); toast.success("Đã thêm tuỳ chọn") }, onError: (er) => toast.error(posErrorMessage(er)) }) }}>
        <Input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Nhóm (Size, Màu, Kiểu)" aria-label="Nhóm tuỳ chọn" className="h-11" />
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên (L, Ít đá…)" aria-label="Tên tuỳ chọn" className="h-11" />
        <Input value={delta} inputMode="text" onChange={(e) => setDelta(e.target.value)} placeholder="Giá cộng thêm (đ, có thể âm)" aria-label="Giá cộng thêm" className="h-11" />
        <Button type="submit" variant="outline" className="min-h-11" disabled={cfg.isPending}>Thêm tuỳ chọn</Button>
      </form>
      <ul className="divide-y">
        {mods.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-2 py-2">
            <span className={cn("text-sm", !m.is_active && "text-muted-foreground line-through")}>
              <b>{m.group_name}</b> · {m.name} {m.price_delta !== 0 && <span className="tabular-nums">({m.price_delta > 0 ? "+" : ""}{vnd(m.price_delta)})</span>}
            </span>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => cfg.mutate({ method: "patch", url: `/pos/modifiers/${m.id}`, body: { is_active: !m.is_active } }, done("Đã cập nhật"))}>{m.is_active ? "Tắt" : "Bật"}</Button>
          </li>
        ))}
        {mods.length === 0 && <li className="py-3 text-sm text-muted-foreground">Chưa có tuỳ chọn nào — món sẽ được thêm thẳng vào đơn khi chạm.</li>}
      </ul>
    </section>
  )
}
