"use client"

import { useEffect, useMemo, useState } from "react"
import { Check, Copy, Loader2, MapPin, Minus, Phone, Plus, ShoppingBag, X } from "lucide-react"

/** Trang bán hàng công khai — fetch thẳng (không phiên đăng nhập, không tự chuyển về /login). */
interface Product { id: number; name: string; price: number; image_url: string | null; description: string | null }
interface Store {
  name: string; tagline: string | null; theme: "toi-gian" | "am-ap" | "soi-dong"; accent: string
  phone: string | null; address: string | null; cover_url?: string | null; logo_url?: string | null
  payment: { cod: boolean; bank_transfer: boolean }; products: Product[]
}
interface Placed {
  code: string; total: number; payment_method: "cod" | "bank_transfer"
  payment: { qr_url: string | null; transfer_content: string; bank: { bank?: string; account_number?: string; account_name?: string | null } | null } | null
}
type Line = Product & { qty: number }

const vnd = (n: number) => `${n.toLocaleString("vi-VN")}đ`
const api = (path: string, init?: RequestInit) => fetch(`/api/v1/store/public${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } })

/** Ba giao diện = bộ biến (nền, chữ, bo góc, phông, kiểu nút). Màu chủ đạo do chủ shop chọn. */
interface Theme { bg: string; surface: string; ink: string; muted: string; line: string; radius: string; btnRadius: string; heading: string; body: string; weight: number }
const THEMES: Record<string, Theme> = {
  "toi-gian": { bg: "#ffffff", surface: "#f6f6f7", ink: "#121317", muted: "#6b6f7a", line: "#e7e8ec", radius: "12px", btnRadius: "10px", heading: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif", body: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif", weight: 600 },
  "am-ap": { bg: "#fbf7f1", surface: "#f3ebdf", ink: "#33261a", muted: "#7c6a57", line: "#e8dccb", radius: "18px", btnRadius: "999px", heading: "Georgia, 'Times New Roman', serif", body: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif", weight: 600 },
  "soi-dong": { bg: "#ffffff", surface: "#f4f1ff", ink: "#15121f", muted: "#625c73", line: "#e6e1f2", radius: "20px", btnRadius: "999px", heading: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif", body: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif", weight: 800 },
}

function useCart(slug: string) {
  const key = `trinity-cart:${slug}`
  // Đọc ngay lúc khởi tạo: giỏ chỉ hiện sau khi tải xong cửa hàng (phía trình duyệt).
  const [cart, setCart] = useState<Record<number, number>>(() => {
    try { return typeof window === "undefined" ? {} : (JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<number, number>) } catch { return {} }
  })
  const save = (next: Record<number, number>) => {
    setCart(next)
    try { window.localStorage.setItem(key, JSON.stringify(next)) } catch { /* trình duyệt chặn lưu trữ */ }
  }
  return {
    cart,
    add: (id: number, d = 1) => save({ ...cart, [id]: Math.max(0, Math.min(99, (cart[id] ?? 0) + d)) }),
    clear: () => save({}),
  }
}

export function Storefront({ slug }: { slug: string }) {
  const [store, setStore] = useState<Store | null>(null)
  const [missing, setMissing] = useState(false)
  const { cart, add, clear } = useCart(slug)
  const [open, setOpen] = useState(false)
  const [placed, setPlaced] = useState<(Placed & { phone: string }) | null>(null)

  useEffect(() => {
    api(`/${encodeURIComponent(slug)}`)
      .then(async (r) => (r.ok ? setStore(await r.json()) : setMissing(true)))
      .catch(() => setMissing(true))
  }, [slug])

  const lines: Line[] = useMemo(() => (store?.products ?? []).filter((p) => (cart[p.id] ?? 0) > 0).map((p) => ({ ...p, qty: cart[p.id] })), [store, cart])
  const total = lines.reduce((t, l) => t + l.price * l.qty, 0)
  const count = lines.reduce((t, l) => t + l.qty, 0)

  if (missing) return <Centered title="Không tìm thấy cửa hàng" body="Địa chỉ này chưa có cửa hàng hoặc cửa hàng đang tạm đóng." />
  if (!store) return <Centered title="" body=""><Loader2 className="size-6 animate-spin text-neutral-400" /></Centered>
  const t = THEMES[store.theme] ?? THEMES["toi-gian"]
  const page = { background: t.bg, color: t.ink, fontFamily: t.body, minHeight: "100dvh" } as React.CSSProperties
  const solid = { background: store.accent, color: "#fff", borderRadius: t.btnRadius } as React.CSSProperties

  if (placed) return <div style={page}><TopBar store={store} t={t} count={0} total={0} onCart={() => setPlaced(null)} cartLabel="Tiếp tục mua" /><OrderDone store={store} t={t} slug={slug} placed={placed} onBack={() => setPlaced(null)} /></div>

  return (
    <div style={page}>
      <TopBar store={store} t={t} count={count} total={total} onCart={() => setOpen(true)} />

      <section className="mx-auto max-w-6xl px-4 pt-6 sm:px-6 sm:pt-8">
        <div className="relative overflow-hidden" style={{ borderRadius: t.radius, background: store.cover_url ? "#000" : `linear-gradient(135deg, ${store.accent}22, ${store.accent}08 55%, ${t.surface})` }}>
          {store.cover_url && (
            // eslint-disable-next-line @next/next/no-img-element -- ảnh bìa do chủ shop nhập (URL ngoài)
            <img src={store.cover_url} alt="" className="absolute inset-0 size-full object-cover opacity-80" />
          )}
          {store.cover_url && <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />}
          <div className={`relative flex min-h-56 flex-col justify-end gap-3 px-6 py-10 sm:min-h-80 sm:px-12 sm:py-14 ${store.cover_url ? "text-white" : ""}`}>
            <h1 className="max-w-2xl text-3xl leading-tight sm:text-5xl" style={{ fontFamily: t.heading, fontWeight: t.weight, letterSpacing: "-0.02em" }}>{store.name}</h1>
            {store.tagline && <p className="max-w-xl text-base sm:text-lg" style={{ color: store.cover_url ? "rgba(255,255,255,.85)" : t.muted }}>{store.tagline}</p>}
            {(store.phone || store.address) && (
              <p className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-sm" style={{ color: store.cover_url ? "rgba(255,255,255,.8)" : t.muted }}>
                {store.phone && <a href={`tel:${store.phone}`} className="inline-flex items-center gap-1.5 hover:underline"><Phone className="size-4" />{store.phone}</a>}
                {store.address && <span className="inline-flex items-center gap-1.5"><MapPin className="size-4" />{store.address}</span>}
              </p>
            )}
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-6xl px-4 pt-12 pb-36 sm:px-6 sm:pt-16">
        <div className="mb-6 flex items-baseline justify-between gap-3 sm:mb-8">
          <h2 className="text-xl sm:text-2xl" style={{ fontFamily: t.heading, fontWeight: t.weight }}>Sản phẩm</h2>
          <span className="text-sm" style={{ color: t.muted }}>{store.products.length} sản phẩm</span>
        </div>
        {store.products.length === 0 ? (
          <p className="py-20 text-center" style={{ color: t.muted }}>Cửa hàng chưa có sản phẩm.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-10 md:grid-cols-3 lg:grid-cols-4 lg:gap-x-6">
            {store.products.map((p) => (
              <li key={p.id} className="group flex flex-col">
                <div className="relative overflow-hidden" style={{ borderRadius: t.radius, background: t.surface }}>
                  {p.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- ảnh sản phẩm do chủ shop nhập (URL ngoài)
                    <img src={p.image_url} alt={p.name} loading="lazy" className="aspect-[4/5] w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]" />
                  ) : (
                    <div className="flex aspect-[4/5] w-full items-center justify-center" style={{ background: `linear-gradient(160deg, ${store.accent}1f, ${t.surface} 70%)` }}>
                      <ShoppingBag className="size-10" style={{ color: `${store.accent}99` }} strokeWidth={1.5} aria-hidden />
                    </div>
                  )}
                  {(cart[p.id] ?? 0) > 0 && <span className="absolute top-2.5 right-2.5 grid h-7 min-w-7 place-items-center rounded-full px-2 text-xs font-semibold text-white shadow" style={{ background: store.accent }}>{cart[p.id]}</span>}
                </div>
                <div className="flex flex-1 flex-col pt-3">
                  <p className="line-clamp-2 text-[15px] leading-snug">{p.name}</p>
                  {/* Giữ chỗ 2 dòng mô tả để giá + nút thẳng hàng giữa các thẻ. */}
                  <p className="mt-1 line-clamp-2 min-h-10 text-[13px] leading-5" style={{ color: t.muted }}>{p.description ?? ""}</p>
                  <p className="mt-auto pt-2 text-base font-semibold tabular-nums">{vnd(p.price)}</p>
                  <div className="mt-3">
                    {(cart[p.id] ?? 0) > 0 ? (
                      <Stepper value={cart[p.id]} onMinus={() => add(p.id, -1)} onPlus={() => add(p.id)} name={p.name} t={t} accent={store.accent} />
                    ) : (
                      <button type="button" onClick={() => add(p.id)} className="h-11 w-full text-sm font-semibold transition-opacity duration-150 hover:opacity-90" style={solid}>Thêm vào giỏ</button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>

      <footer className="border-t px-4 py-10 text-center text-sm sm:px-6" style={{ borderColor: t.line, color: t.muted }}>
        <p className="font-medium" style={{ color: t.ink }}>{store.name}</p>
        <p className="mt-1">{[store.phone, store.address].filter(Boolean).join(" · ")}</p>
      </footer>

      {/* Giỏ nổi trên điện thoại: thanh dưới đáy (máy tính dùng nút góc phải ở thanh trên). */}
      {count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t p-3 sm:hidden" style={{ background: t.bg, borderColor: t.line }}>
          <button type="button" onClick={() => setOpen(true)} className="flex h-12 w-full items-center justify-between px-5 text-[15px] font-semibold" style={solid}>
            <span className="flex items-center gap-2"><ShoppingBag className="size-5" /> {count} món</span>
            <span className="tabular-nums">{vnd(total)} · Xem giỏ</span>
          </button>
        </div>
      )}

      {open && <Checkout store={store} t={t} lines={lines} total={total} slug={slug} add={add} onClose={() => setOpen(false)} onPlaced={(p) => { clear(); setOpen(false); setPlaced(p) }} />}
    </div>
  )
}

function TopBar({ store, t, count, total, onCart, cartLabel }: { store: Store; t: Theme; count: number; total: number; onCart: () => void; cartLabel?: string }) {
  return (
    <header className="sticky top-0 z-20 border-b backdrop-blur" style={{ background: `${t.bg}e6`, borderColor: t.line }}>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <span className="flex min-w-0 items-center gap-2.5">
          {store.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- logo do chủ shop nhập
            <img src={store.logo_url} alt="" className="size-9 rounded-full object-cover" />
          ) : (
            <span className="grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold text-white" style={{ background: store.accent }}>{store.name.slice(0, 1).toUpperCase()}</span>
          )}
          <span className="truncate text-[15px] font-semibold" style={{ fontFamily: t.heading }}>{store.name}</span>
        </span>
        <button type="button" onClick={onCart} aria-label={cartLabel ?? `Giỏ hàng: ${count} món`} className="hidden h-10 items-center gap-2 px-4 text-sm font-semibold sm:inline-flex" style={{ background: count ? store.accent : t.surface, color: count ? "#fff" : t.ink, borderRadius: t.btnRadius }}>
          <ShoppingBag className="size-4" /> {cartLabel ?? (count ? <>{count} món · {vnd(total)}</> : "Giỏ hàng")}
        </button>
      </div>
    </header>
  )
}

function Stepper({ value, onMinus, onPlus, name, t, accent }: { value: number; onMinus: () => void; onPlus: () => void; name: string; t: Theme; accent: string }) {
  return (
    <div className="flex h-11 items-center justify-between border px-1" style={{ borderColor: accent, borderRadius: t.btnRadius }}>
      <button type="button" aria-label={`Bớt ${name}`} onClick={onMinus} className="grid size-9 place-items-center rounded-full" style={{ color: accent }}><Minus className="size-4" /></button>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
      <button type="button" aria-label={`Thêm ${name}`} onClick={onPlus} className="grid size-9 place-items-center rounded-full" style={{ color: accent }}><Plus className="size-4" /></button>
    </div>
  )
}

function StepTitle({ n, children, t, accent }: { n: number; children: React.ReactNode; t: Theme; accent: string }) {
  return (
    <h3 className="flex items-center gap-2.5 text-base" style={{ fontFamily: t.heading, fontWeight: t.weight }}>
      <span className="grid size-6 place-items-center rounded-full text-xs font-bold text-white" style={{ background: accent }}>{n}</span>{children}
    </h3>
  )
}

function Checkout({ store, t, lines, total, slug, add, onClose, onPlaced }: {
  store: Store; t: Theme; lines: Line[]; total: number; slug: string; add: (id: number, d?: number) => void
  onClose: () => void; onPlaced: (p: Placed & { phone: string }) => void
}) {
  const [f, setF] = useState({ name: "", phone: "", address: "", note: "", payment_method: store.payment.cod ? "cod" : "bank_transfer" })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = { background: t.bg, color: t.ink, borderRadius: "10px", border: `1px solid ${t.line}` } as React.CSSProperties
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api(`/${encodeURIComponent(slug)}/orders`, { method: "POST", body: JSON.stringify({ ...f, items: lines.map((l) => ({ product_id: l.id, quantity: l.qty })) }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(Array.isArray(j.message) ? j.message.join("; ") : j.message || "Không đặt được đơn, vui lòng thử lại.")
      onPlaced({ ...(j as Placed), phone: f.phone })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const pay = (value: "cod" | "bank_transfer", title: string, sub: string) => (
    <label className="flex cursor-pointer items-start gap-3 border p-4" style={{ borderColor: f.payment_method === value ? store.accent : t.line, borderRadius: "12px", background: f.payment_method === value ? `${store.accent}0d` : "transparent" }}>
      <input type="radio" name="pm" className="mt-1" checked={f.payment_method === value} onChange={() => setF({ ...f, payment_method: value })} />
      <span className="flex flex-col"><span className="text-sm font-semibold">{title}</span><span className="text-[13px]" style={{ color: t.muted }}>{sub}</span></span>
    </label>
  )
  return (
    <div role="dialog" aria-modal="true" aria-label="Đặt hàng" className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="flex h-dvh w-full flex-col sm:max-w-md" style={{ background: t.bg, color: t.ink, fontFamily: t.body }}>
        <div className="flex h-16 shrink-0 items-center justify-between border-b px-5" style={{ borderColor: t.line }}>
          <h2 className="text-lg" style={{ fontFamily: t.heading, fontWeight: t.weight }}>Đặt hàng</h2>
          <button type="button" onClick={onClose} aria-label="Đóng" className="grid size-10 place-items-center rounded-full"><X className="size-5" /></button>
        </div>
        <div className="flex flex-1 flex-col gap-8 overflow-y-auto px-5 py-6">
          <section className="flex flex-col gap-3">
            <StepTitle n={1} t={t} accent={store.accent}>Giỏ hàng</StepTitle>
            {lines.length === 0 ? <p className="text-sm" style={{ color: t.muted }}>Giỏ hàng trống.</p> : (
              <ul className="flex flex-col divide-y" style={{ borderColor: t.line }}>
                {lines.map((l) => (
                  <li key={l.id} className="flex items-center gap-3 py-3" style={{ borderColor: t.line }}>
                    {l.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- ảnh sản phẩm
                      <img src={l.image_url} alt="" className="size-14 shrink-0 object-cover" style={{ borderRadius: "10px" }} />
                    ) : <span className="grid size-14 shrink-0 place-items-center" style={{ background: t.surface, borderRadius: "10px" }}><ShoppingBag className="size-5" style={{ color: t.muted }} /></span>}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{l.name}</span>
                      <span className="text-[13px] tabular-nums" style={{ color: t.muted }}>{vnd(l.price)}</span>
                    </span>
                    <span className="flex items-center gap-1">
                      <button type="button" aria-label={`Bớt ${l.name}`} onClick={() => add(l.id, -1)} className="grid size-8 place-items-center rounded-full border" style={{ borderColor: t.line }}><Minus className="size-3.5" /></button>
                      <span className="w-6 text-center text-sm tabular-nums">{l.qty}</span>
                      <button type="button" aria-label={`Thêm ${l.name}`} onClick={() => add(l.id)} className="grid size-8 place-items-center rounded-full border" style={{ borderColor: t.line }}><Plus className="size-3.5" /></button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="flex flex-col gap-3">
            <StepTitle n={2} t={t} accent={store.accent}>Thông tin nhận hàng</StepTitle>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">Họ tên<input required maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="h-12 px-3.5 text-[15px] font-normal" style={field} autoComplete="name" /></label>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">Số điện thoại<input required inputMode="tel" maxLength={20} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} className="h-12 px-3.5 text-[15px] font-normal" style={field} autoComplete="tel" /></label>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">Địa chỉ nhận hàng<input required={f.payment_method === "cod"} maxLength={300} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} className="h-12 px-3.5 text-[15px] font-normal" style={field} autoComplete="street-address" /></label>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">Ghi chú (không bắt buộc)<input maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} className="h-12 px-3.5 text-[15px] font-normal" style={field} /></label>
          </section>
          <section className="flex flex-col gap-3">
            <StepTitle n={3} t={t} accent={store.accent}>Thanh toán</StepTitle>
            {store.payment.bank_transfer && pay("bank_transfer", "Chuyển khoản (quét mã QR)", "Cửa hàng tự nhận khi tiền về — không cần chụp màn hình")}
            {store.payment.cod && pay("cod", "Trả tiền khi nhận hàng (COD)", "Thanh toán cho người giao hàng")}
          </section>
        </div>
        <div className="shrink-0 border-t px-5 py-4" style={{ borderColor: t.line }}>
          <div className="mb-3 flex items-baseline justify-between"><span className="text-sm" style={{ color: t.muted }}>Tổng cộng</span><span className="text-xl font-semibold tabular-nums">{vnd(total)}</span></div>
          {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={busy || lines.length === 0} className="flex h-12 w-full items-center justify-center gap-2 text-base font-semibold disabled:opacity-50" style={{ background: store.accent, color: "#fff", borderRadius: t.btnRadius }}>
            {busy && <Loader2 className="size-4 animate-spin" />} Đặt hàng · {vnd(total)}
          </button>
        </div>
      </form>
    </div>
  )
}

function CopyText({ value, label }: { value: string; label: string }) {
  const [ok, setOk] = useState(false)
  return (
    <button type="button" aria-label={label} onClick={async () => { try { await navigator.clipboard.writeText(value); setOk(true); setTimeout(() => setOk(false), 1500) } catch { /* chọn và chép tay */ } }}
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap" style={{ borderColor: "currentColor" }}>
      {ok ? <Check className="size-4" /> : <Copy className="size-4" />} {ok ? "Đã chép" : "Sao chép"}
    </button>
  )
}

function OrderDone({ store, t, slug, placed, onBack }: { store: Store; t: Theme; slug: string; placed: Placed & { phone: string }; onBack: () => void }) {
  const [status, setStatus] = useState<string>("new")
  const transfer = placed.payment_method === "bank_transfer" && placed.payment
  // Vào trang kết quả từ cuối trang sản phẩm ⇒ đưa về đầu để thấy QR ngay.
  useEffect(() => { try { window.scrollTo({ top: 0 }) } catch { /* jsdom */ } }, [])
  useEffect(() => {
    if (!transfer || status === "paid") return
    // Chờ tiền về (SePay tự khớp) — hỏi lại mỗi 5 giây, tối đa 20 phút.
    let n = 0
    const id = setInterval(async () => {
      if (++n > 240) return clearInterval(id)
      const r = await api(`/${encodeURIComponent(slug)}/orders/${placed.code}?phone=${encodeURIComponent(placed.phone)}`).catch(() => null)
      if (r?.ok) {
        const j = await r.json()
        setStatus(j.status)
        if (j.status === "paid") clearInterval(id)
      }
    }, 5000)
    return () => clearInterval(id)
  }, [transfer, status, slug, placed])
  const paid = status === "paid"
  return (
    <main className="mx-auto flex max-w-lg flex-col items-center gap-5 px-4 py-14 text-center sm:py-20">
      <span className="grid size-14 place-items-center rounded-full text-white" style={{ background: paid || !transfer ? "#16a34a" : store.accent }}>
        {paid || !transfer ? <Check className="size-7" /> : <Loader2 className="size-7 animate-spin" />}
      </span>
      <h1 className="text-2xl sm:text-3xl" style={{ fontFamily: t.heading, fontWeight: t.weight }}>{paid ? "Đã nhận thanh toán" : transfer ? "Quét mã để thanh toán" : "Đặt hàng thành công"}</h1>
      <p style={{ color: t.muted }}>Mã đơn <b style={{ color: t.ink }}>{placed.code}</b> · <span className="tabular-nums">{vnd(placed.total)}</span></p>
      {transfer && !paid ? (
        <div className="flex w-full flex-col items-center gap-4 border p-5 sm:p-6" style={{ borderColor: t.line, borderRadius: t.radius, background: t.surface }}>
          {placed.payment!.qr_url && (
            // eslint-disable-next-line @next/next/no-img-element -- ảnh QR từ qr.sepay.vn
            <img src={placed.payment!.qr_url} alt={`Mã QR chuyển ${vnd(placed.total)}`} className="aspect-square w-full max-w-80 rounded-xl bg-white p-3" />
          )}
          <div className="flex w-full flex-col gap-2 text-left text-sm">
            <div className="flex flex-col gap-1.5">
              <span style={{ color: t.muted }}>Nội dung chuyển khoản</span>
              <span className="flex items-center justify-between gap-3 rounded-lg px-3 py-2" style={{ background: t.bg }}>
                <span className="font-mono text-lg font-semibold tracking-wide">{placed.payment!.transfer_content}</span>
                <CopyText value={placed.payment!.transfer_content} label="Sao chép nội dung chuyển khoản" />
              </span>
            </div>
            <div className="flex justify-between gap-3"><span style={{ color: t.muted }}>Số tiền</span><span className="font-semibold tabular-nums">{vnd(placed.total)}</span></div>
            {placed.payment!.bank && <div className="flex justify-between gap-3"><span style={{ color: t.muted }}>Tài khoản</span><span className="text-right">{[placed.payment!.bank.bank, placed.payment!.bank.account_number, placed.payment!.bank.account_name].filter(Boolean).join(" · ")}</span></div>}
          </div>
          <p className="text-[13px]" style={{ color: t.muted }}>Giữ nguyên nội dung để cửa hàng tự nhận tiền. Trang tự cập nhật khi tiền về.</p>
        </div>
      ) : (
        <p style={{ color: t.muted }}>{store.name} sẽ gọi số {placed.phone} để xác nhận và giao hàng.</p>
      )}
      <button type="button" onClick={onBack} className="mt-2 h-11 px-6 text-sm font-semibold" style={{ border: `1px solid ${t.line}`, borderRadius: t.btnRadius }}>Tiếp tục mua</button>
    </main>
  )
}

function Centered({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-neutral-50 px-6 text-center">
      {children}
      {title && <h1 className="text-xl font-semibold text-neutral-900">{title}</h1>}
      {body && <p className="text-neutral-500">{body}</p>}
    </main>
  )
}
