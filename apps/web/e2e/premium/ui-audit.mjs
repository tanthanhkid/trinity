// Rà nền tảng UI (docs/TRANG-THAI.md mục "Nền tảng UI"): mỗi màn chính, ở 360px (điện thoại) và 1280px (máy tính):
//  - tràn ngang: trang không được cuộn ngang ở 360px;
//  - vùng chạm: nút/link/ô chọn ở điện thoại cao/rộng ≥ 44px (trừ link nằm trong đoạn chữ);
//  - focus bàn phím: Tab qua 25 phần tử đầu, phần tử nào đang focus phải có viền/vòng thấy được;
//  - chuyển động ngắt được: bật "giảm chuyển động" ⇒ không còn animation nào chạy quá 0,01 giây.
// API giả qua CDP Fetch (fixtures.mjs), Chrome hồ sơ tạm. Chạy: node e2e/premium/ui-audit.mjs  (web chạy ở BASE_URL)
import { BASE_URL, launch, mockApi, signIn } from "./harness.mjs"
import { handle } from "./fixtures.mjs"

export const PAGES = ["/dashboard", "/contacts", "/kanban", "/social", "/connections", "/inbox", "/products", "/pos", "/management/employees"]
const MIN = 44

/** Ngoại lệ đã biết, có lý do và hạn sửa — KHÔNG thêm vào đây để né lỗi mới. */
export const ALLOW = [
  // home-ai-hub.tsx thuộc PR #48 (đang chờ); sửa link này ngay sau khi #48 gộp rồi xoá dòng này.
  { path: "/dashboard", label: "Xem tất cả tính năng" },
]

async function open(path, viewport, opts = {}) {
  const h = await launch({ viewport })
  await signIn(h.context)
  await mockApi(h.cdp, (req) => handle(req))
  if (opts.reducedMotion) await h.page.emulateMedia({ reducedMotion: "reduce" })
  await h.page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle", timeout: 180_000 })
  await h.page.waitForTimeout(1500)
  return h
}

/** Phần tử bấm được, đang hiện, nằm trong vùng nội dung + thanh trên (bỏ thanh bên đã thu ở điện thoại). */
const collectTargets = () => {
  const sel = 'a[href], button, [role="button"], [role="tab"], input[type="checkbox"], input[type="radio"], select, [role="switch"]'
  const out = []
  for (const el of document.querySelectorAll(sel)) {
    // Ô chọn nằm trong <label>: bấm cả nhãn là chọn được ⇒ đo nhãn.
    const hit = el.tagName === "INPUT" && el.closest("label") ? el.closest("label") : el
    const r = hit.getBoundingClientRect()
    const st = getComputedStyle(el)
    if (r.width === 0 || r.height === 0 || st.visibility === "hidden" || el.closest('[aria-hidden="true"]')) continue
    if (el.closest('[data-sidebar="sidebar"]') && r.right <= 0) continue
    // Link nằm giữa câu chữ: ngoại lệ của WCAG 2.5.5/2.5.8.
    const inline = el.tagName === "A" && st.display === "inline" && el.parentElement && getComputedStyle(el.parentElement).display === "block"
    if (inline) continue
    const label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40)
    out.push({ label, w: Math.round(r.width), h: Math.round(r.height) })
  }
  return out
}

const focusSnapshot = () => {
  const el = document.activeElement
  if (!el || el === document.body) return null
  const st = getComputedStyle(el)
  const ring = (st.outlineStyle !== "none" && parseFloat(st.outlineWidth) > 0) || (st.boxShadow && st.boxShadow !== "none")
  const label = (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40)
  return { label, ring: Boolean(ring) }
}

export async function audit(path) {
  const res = { path }
  // 360px: tràn ngang + vùng chạm
  {
    const h = await open(path, { width: 360, height: 740 })
    res.overflow360 = await h.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    const targets = await h.page.evaluate(collectTargets)
    res.targets = targets.length
    res.small = targets.filter((t) => t.h < MIN || t.w < MIN)
    await h.close()
  }
  // 1280px: focus bàn phím (Tab 25 lần)
  {
    const h = await open(path, { width: 1280, height: 800 })
    const seen = []
    for (let i = 0; i < 25; i++) {
      await h.page.keyboard.press("Tab")
      const s = await h.page.evaluate(focusSnapshot)
      if (s) seen.push(s)
    }
    res.focusChecked = seen.length
    res.noRing = seen.filter((s) => !s.ring)
    await h.close()
  }
  // giảm chuyển động
  {
    const h = await open(path, { width: 1280, height: 800 }, { reducedMotion: true })
    res.longAnimations = await h.page.evaluate(() =>
      document.getAnimations().filter((a) => {
        const t = a.effect?.getTiming?.()
        return a.playState === "running" && t && Number(t.duration) > 10 && t.iterations !== 0
      }).length,
    )
    await h.close()
  }
  return res
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("ui-audit.mjs")) {
  const only = process.argv.slice(2)
  const results = []
  for (const p of only.length ? only : PAGES) {
    try {
      results.push(await audit(p))
    } catch (e) {
      results.push({ path: p, error: String(e).slice(0, 200) })
    }
  }
  console.log(JSON.stringify(results, null, 2))
  // Lỗi = tràn ngang, vùng chạm < 44px (trừ ALLOW), focus không thấy, animation khi giảm chuyển động, trang không mở được.
  const problems = []
  for (const r of results) {
    if (r.error) { problems.push(`${r.path}: không mở được — ${r.error}`); continue }
    if (r.overflow360 > 0) problems.push(`${r.path}: tràn ngang ${r.overflow360}px ở 360px`)
    for (const t of r.small.filter((t) => !ALLOW.some((a) => a.path === r.path && a.label === t.label))) problems.push(`${r.path}: vùng chạm "${t.label}" ${t.w}×${t.h}px`)
    for (const n of r.noRing) problems.push(`${r.path}: focus không thấy ở "${n.label}"`)
    if (r.longAnimations > 0) problems.push(`${r.path}: ${r.longAnimations} animation vẫn chạy khi bật giảm chuyển động`)
  }
  console.error(problems.length ? [`❌ ${problems.length} lỗi:`, ...problems].join("\n") : "✅ Không có lỗi nền tảng UI")
  process.exitCode = problems.length ? 1 : 0
}
