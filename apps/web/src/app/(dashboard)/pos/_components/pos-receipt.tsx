"use client"

import { createContext, useCallback, useContext, useState, type ReactNode } from "react"
import { formatDateTimeVn } from "@/lib/format"
import { vnd } from "@/lib/pos-format"
import type { ReceiptData } from "@/lib/pos-receipt"
import type { PosSettings } from "@/types/pos"

/**
 * In hoá đơn khổ 80mm bằng `window.print`. Một vùng in duy nhất (`#pos-print-area`) nằm ở gốc màn POS;
 * CSS `@media print` ẩn toàn bộ trang còn lại và đặt `@page` rộng 80mm. Máy in nhiệt: chọn "khổ 80mm" trong hộp thoại in.
 */
type PrintFn = (data: ReceiptData) => void
const PrintContext = createContext<PrintFn>(() => undefined)
export const usePosPrint = (): PrintFn => useContext(PrintContext)

const PRINT_CSS = `
#pos-print-area{display:none}
@media print{
  @page{size:80mm auto;margin:0}
  body *{visibility:hidden!important}
  #pos-print-area,#pos-print-area *{visibility:visible!important}
  #pos-print-area{display:block!important;position:absolute;left:0;top:0;width:80mm;padding:4mm;color:#000;background:#fff;font:12px/1.35 ui-monospace,Menlo,monospace}
}`

function Row({ l, r, bold }: { l: ReactNode; r: ReactNode; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontWeight: bold ? 700 : 400 }}>
      <span>{l}</span><span>{r}</span>
    </div>
  )
}

export function PosPrintProvider({ settings, children }: { settings?: PosSettings; children: ReactNode }) {
  const [data, setData] = useState<ReceiptData | null>(null)
  const print = useCallback<PrintFn>((d) => {
    setData(d)
    // Chờ React vẽ xong vùng in rồi mới mở hộp thoại in.
    window.setTimeout(() => window.print(), 80)
  }, [])
  return (
    <PrintContext.Provider value={print}>
      {children}
      <style>{PRINT_CSS}</style>
      <div id="pos-print-area" aria-hidden>{data && <ReceiptBody data={data} settings={settings} />}</div>
    </PrintContext.Provider>
  )
}

function ReceiptBody({ data, settings }: { data: ReceiptData; settings?: PosSettings }) {
  const hr = <div style={{ borderTop: "1px dashed #000", margin: "4px 0" }} />
  return (
    <div>
      <div style={{ textAlign: "center", fontWeight: 700, fontSize: 15 }}>{settings?.store_name ?? "Quán"}</div>
      {settings?.address && <div style={{ textAlign: "center" }}>{settings.address}</div>}
      {settings?.phone && <div style={{ textAlign: "center" }}>ĐT: {settings.phone}</div>}
      {hr}
      <div style={{ textAlign: "center", fontWeight: 700 }}>{data.kind === "bill" ? "HOÁ ĐƠN" : "PHIẾU TẠM TÍNH"}</div>
      <Row l={`Số: ${data.code}`} r={data.place} />
      {data.at && <div>Ngày: {formatDateTimeVn(data.at)}</div>}
      {hr}
      {data.lines.map((l, i) => (
        <div key={i} style={{ marginBottom: 3 }}>
          <div>{l.name}</div>
          {(l.options || l.note) && <div style={{ paddingLeft: 8 }}>{[l.options, l.note].filter(Boolean).join(" · ")}</div>}
          <Row l={`${l.quantity} x ${vnd(l.unit)}`} r={vnd(l.total)} />
        </div>
      ))}
      {hr}
      <Row l="Tạm tính" r={vnd(data.subtotal)} />
      {data.discount > 0 && <Row l="Giảm giá" r={`-${vnd(data.discount)}`} />}
      <Row l="TỔNG CỘNG" r={vnd(data.total)} bold />
      {data.payments.map((p, i) => (
        <div key={i}>
          <Row l={p.method === "cash" ? "Tiền mặt" : "Chuyển khoản"} r={vnd(p.amount)} />
          {p.method === "cash" && p.tendered != null && p.change > 0 && (
            <Row l={`Khách đưa ${vnd(p.tendered)}`} r={`Thối ${vnd(p.change)}`} />
          )}
        </div>
      ))}
      {hr}
      <div style={{ textAlign: "center" }}>{settings?.receipt_footer || "Cảm ơn quý khách!"}</div>
    </div>
  )
}
