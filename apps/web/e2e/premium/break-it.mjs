// "Cố tình phá" tự động (docs/TRANG-THAI.md mục "Cố tình phá"): mỗi tình huống mở Chrome headless hồ sơ tạm,
// chặn API bằng CDP Fetch (không gọi máy chủ thật), làm hỏng một thứ rồi kiểm màn hình có nói thật + có lối ra.
// Chạy: node e2e/premium/break-it.mjs [tên-tình-huống…]   (web chạy ở BASE_URL; in bảng kết quả, mã thoát 1 nếu có lệch)
import { BASE_URL, launch, mockApi, setOffline, signIn } from "./harness.mjs"
import { handle } from "./fixtures.mjs"

const json = (status, body) => () => ({ status, json: body })

/** Mở trang với kịch bản API riêng; `scenario` là object sống — sửa giữa chừng để "chữa" lỗi (vd trước khi bấm Thử lại). */
async function open(path, scenario = {}, viewport = { width: 1280, height: 800 }) {
  const h = await launch({ viewport })
  await signIn(h.context)
  const api = await mockApi(h.cdp, (req) => handle(req, scenario))
  await h.page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle", timeout: 180_000 })
  await h.page.waitForTimeout(800)
  return { ...h, api, scenario }
}

const text = (page) => page.locator("main").last().innerText().catch(() => "")
const visible = (loc) => loc.first().isVisible().catch(() => false)

/** Mỗi tình huống: { name, expect, run(): Promise<{ ok, actual }> }. */
export const CASES = [
  {
    name: "mat-mang-giua-luong",
    expect: "Mất mạng giữa lúc dùng ⇒ dải 'Mất kết nối mạng' hiện; có mạng lại ⇒ dải tắt + báo 'Đã có mạng lại'",
    async run() {
      const h = await open("/contacts")
      try {
        await setOffline(h.context, true)
        await h.page.waitForTimeout(500)
        const banner = await visible(h.page.getByTestId("offline-banner"))
        await setOffline(h.context, false)
        await h.page.waitForTimeout(800)
        const gone = !(await visible(h.page.getByTestId("offline-banner")))
        const toast = await visible(h.page.getByText("Đã có mạng lại"))
        return { ok: banner && gone && toast, actual: `dải mất mạng: ${banner ? "có" : "KHÔNG"}; có mạng lại: dải ${gone ? "tắt" : "VẪN HIỆN"}, toast ${toast ? "có" : "KHÔNG"}` }
      } finally { await h.close() }
    },
  },
  {
    name: "mat-mang-luc-mo-trang",
    expect: "Mở danh sách khách khi API không tới được ⇒ khung lỗi 'Không kết nối được máy chủ' + Thử lại (không phải 'chưa có khách')",
    async run() {
      const h = await open("/contacts", { "GET /contacts": () => ({ fail: "InternetDisconnected" }) })
      try {
        const t = await text(h.page)
        // Không được nói dối là "0 khách" / "Không có khách hàng" khi thật ra là không tải được.
        const ok = /Không kết nối được máy chủ/.test(t) && (await visible(h.page.getByRole("button", { name: "Thử lại" }))) && !/Chưa có khách hàng nào|Không có khách hàng|0 khách/.test(t)
        return { ok, actual: t.replace(/\s+/g, " ").slice(0, 160) }
      } finally { await h.close() }
    },
  },
  {
    name: "api-500-roi-thu-lai",
    expect: "API khách hàng trả 500 ⇒ 'máy chủ đang gặp sự cố' + Thử lại; máy chủ hết lỗi, bấm Thử lại ⇒ danh sách hiện",
    async run() {
      const h = await open("/contacts", { "GET /contacts": json(500, { message: "Internal server error" }) })
      try {
        const t1 = await text(h.page)
        const said = /máy chủ đang gặp sự cố/i.test(t1) && !/Internal server error/.test(t1)
        delete h.scenario["GET /contacts"]
        await h.page.getByRole("button", { name: "Thử lại" }).first().click()
        await h.page.waitForTimeout(1500)
        const t2 = await text(h.page)
        const recovered = !/Không tải được danh sách khách hàng/.test(t2) && /Nguyễn Văn Bình|Trần Thị Hoa/.test(t2)
        return { ok: said && recovered, actual: `lúc lỗi: ${said ? "nói đúng" : t1.replace(/\s+/g, " ").slice(0, 120)}; sau Thử lại: ${recovered ? "danh sách hiện" : "VẪN LỖI"}` }
      } finally { await h.close() }
    },
  },
  {
    name: "api-500-cac-man",
    expect: "API chính của Kanban, Đăng đa kênh, Tổng quan trả 500 ⇒ mỗi màn hiện khung lỗi + Thử lại, không nói 'chưa có'/'0'",
    async run() {
      const cases = [
        ["/kanban", { "GET /kanban/boards": json(500, {}) }, /Chưa có board nào/],
        ["/social?tab=posts", { "GET /social/posts": json(500, {}) }, /Chưa có bài nào/],
        ["/dashboard", { "GET /reports/dashboard-overview": json(500, {}) }, /0 ₫/],
      ]
      const parts = []
      let ok = true
      for (const [path, sc, lie] of cases) {
        const h = await open(path, sc)
        try {
          const t = await text(h.page)
          const good = /Không tải được/.test(t) && /máy chủ đang gặp sự cố/i.test(t) && (await visible(h.page.getByRole("button", { name: "Thử lại" }))) && !lie.test(t)
          ok &&= good
          parts.push(`${path}: ${good ? "đúng" : "LỆCH"}`)
        } finally { await h.close() }
      }
      return { ok, actual: parts.join("; ") }
    },
  },
  {
    name: "api-500-man-khac",
    expect: "API chính của Sản phẩm, Nhân sự, POS (ca đang mở) trả 500 ⇒ khung lỗi + Thử lại; KHÔNG nói 'Chưa có…' và KHÔNG mời 'Mở ca' khi chưa biết có ca hay không",
    async run() {
      const cases = [
        ["/products", { "GET /products": json(500, {}) }, /Chưa có sản phẩm nào/],
        ["/management/employees", { "GET /management/employees": json(500, {}) }, /Chưa có nhân viên nào/],
        ["/pos", { "GET /pos/shifts/current": json(500, {}) }, /Mở ca/],
      ]
      const parts = []
      let ok = true
      for (const [path, sc, lie] of cases) {
        const h = await open(path, sc)
        try {
          const t = await text(h.page)
          const good = /Không (tải|đọc) được/.test(t) && /máy chủ đang gặp sự cố/i.test(t) && (await visible(h.page.getByRole("button", { name: "Thử lại" }))) && !lie.test(t)
          ok &&= good
          parts.push(`${path}: ${good ? "đúng" : "LỆCH — " + t.replace(/\s+/g, " ").slice(0, 80)}`)
        } finally { await h.close() }
      }
      return { ok, actual: parts.join("; ") }
    },
  },
  {
    name: "pos-mat-mang",
    expect: "POS mất mạng ⇒ khoá Lưu đơn / Thanh toán + câu 'giỏ hàng vẫn giữ nguyên'; có mạng lại ⇒ mở lại",
    async run() {
      const h = await open("/pos")
      try {
        await h.page.getByRole("button", { name: /Cà phê sữa đá/ }).first().click()
        await h.page.waitForTimeout(500)
        // Món có tuỳ chọn mở hộp thoại — bấm nút thêm nếu có.
        const add = h.page.getByRole("button", { name: /^Thêm ·/ })
        if (await visible(add)) await add.first().click()
        await setOffline(h.context, true)
        await h.page.waitForTimeout(400)
        const pay = h.page.getByRole("button", { name: "Thanh toán" }).first()
        const locked = await pay.isDisabled()
        const said = await visible(h.page.getByText(/Đang mất mạng — chưa lưu \/ thu tiền được/))
        await setOffline(h.context, false)
        await h.page.waitForTimeout(400)
        const back = await pay.isEnabled()
        return { ok: locked && said && back, actual: `khoá Thanh toán: ${locked ? "có" : "KHÔNG"}; câu giải thích: ${said ? "có" : "KHÔNG"}; có mạng lại mở: ${back ? "có" : "KHÔNG"}` }
      } finally { await h.close() }
    },
  },
  {
    name: "an-san-pham-hoan-tac",
    expect: "Ẩn sản phẩm ⇒ PATCH is_active=false + toast Hoàn tác; bấm ⇒ PATCH is_active=true (đảo lại)",
    async run() {
      const bodies = []
      const h = await open("/products", { "/^PATCH \\/products\\/\\d+$/": (req) => (bodies.push(req.body ?? ""), { status: 200, json: {} }) })
      try {
        await h.page.getByRole("button", { name: "Ẩn" }).first().click()
        await h.page.waitForTimeout(600)
        const hid = bodies.some((b) => /"is_active":\s*false/.test(b))
        await h.page.getByRole("button", { name: "Hoàn tác" }).click()
        await h.page.waitForTimeout(600)
        const undone = bodies.some((b) => /"is_active":\s*true/.test(b))
        return { ok: hid && undone, actual: `PATCH ẩn: ${hid ? "có" : "KHÔNG"}; Hoàn tác PATCH mở bán lại: ${undone ? "có" : "KHÔNG"}` }
      } finally { await h.close() }
    },
  },
  {
    name: "xoa-san-pham-hoan-tac",
    expect: "Xoá sản phẩm ⇒ DELETE (lưu trữ) gửi ngay, sản phẩm biến khỏi danh mục + toast Hoàn tác; bấm ⇒ POST /products/:id/restore",
    async run() {
      // Máy chủ giả có trạng thái: xoá thì biến khỏi danh mục, khôi phục thì hiện lại.
      const gone = new Set()
      const h = await open("/products", {
        "/^DELETE \\/products\\/\\d+$/": (req) => (gone.add(req.path.split("/")[2]), { status: 200, json: { archived: true } }),
        "/^POST \\/products\\/\\d+\\/restore$/": (req) => (gone.delete(req.path.split("/")[2]), { status: 200, json: {} }),
        "GET /products": (req) => {
          const base = handle(req)
          return { ...base, json: base.json.filter((p) => !gone.has(String(p.id))) }
        },
      })
      try {
        const name = "Cà phê sữa đá"
        await h.page.getByRole("button", { name: "Thao tác khác" }).first().click().catch(() => {})
        const del = h.page.getByRole("button", { name: /^Xoá$/ }).or(h.page.getByRole("menuitem", { name: /^Xoá$/ }))
        await del.first().click()
        await h.page.getByRole("dialog").getByRole("button", { name: /^Xoá$/ }).click()
        await h.page.waitForTimeout(900)
        const sent = h.api.log.some((l) => /^DELETE \/products\/\d+$/.test(l))
        const hidden = !(await h.page.locator("main").last().innerText()).includes(name)
        await h.page.getByRole("button", { name: "Hoàn tác" }).click()
        await h.page.waitForTimeout(900)
        const restored = h.api.log.some((l) => /^POST \/products\/\d+\/restore$/.test(l))
        return {
          ok: sent && hidden && restored,
          actual: `DELETE gửi ngay: ${sent ? "có" : "KHÔNG"}; biến khỏi danh mục: ${hidden ? "có" : "KHÔNG"}; Hoàn tác gọi restore: ${restored ? "có" : "KHÔNG"}`,
        }
      } finally { await h.close() }
    },
  },
  {
    name: "api-401-het-phien",
    expect: "Phiên hết hạn (401 và làm mới token cũng 401) ⇒ về trang đăng nhập, không kẹt màn trắng/lỗi",
    async run() {
      const h = await open("/contacts", {
        "GET /contacts": json(401, { message: "Unauthorized" }),
        "POST /auth/refresh": json(401, { message: "Unauthorized" }),
      })
      try {
        await h.page.waitForTimeout(2500)
        const url = h.page.url()
        const t = await h.page.locator("body").innerText()
        const ok = /\/login/.test(url) && !/Unauthorized/.test(t)
        return { ok, actual: `URL: ${url.replace(BASE_URL, "")}` }
      } finally { await h.close() }
    },
  },
  {
    name: "danh-sach-trong",
    expect: "Không có khách trong bộ lọc mặc định (7 ngày) ⇒ 'không khớp bộ lọc' + Xoá bộ lọc, nói một lần; bỏ lọc mà vẫn trống ⇒ 'Chưa có khách hàng nào' + Thêm khách; không có board ⇒ Tạo board",
    async run() {
      const a = await open("/contacts", { "GET /contacts": json(200, { data: [], meta: { total: 0, page: 1, pages: 1, limit: 25 } }) })
      let contacts
      try {
        const t1 = await text(a.page)
        const filtered = /Không có khách nào khớp bộ lọc/.test(t1) && !/Không có khách hàng(?! nào)/.test(t1)
        await a.page.getByRole("button", { name: "Xoá bộ lọc" }).first().click()
        await a.page.waitForTimeout(1200)
        const t2 = await text(a.page)
        const fresh = /Chưa có khách hàng nào/.test(t2) && (await visible(a.page.locator("main").last().getByRole("button", { name: /Thêm khách/ })))
        contacts = filtered && fresh
      } finally { await a.close() }
      const b = await open("/kanban", { "GET /kanban/boards": json(200, []) })
      let kanban
      try {
        kanban = /Chưa có board nào/.test(await text(b.page)) && (await visible(b.page.getByRole("link", { name: "Tạo board" })))
      } finally { await b.close() }
      return { ok: contacts && kanban, actual: `khách hàng: ${contacts ? "đúng" : "THIẾU"}; kanban: ${kanban ? "đúng" : "THIẾU"}` }
    },
  },
  {
    name: "token-kenh-het-han",
    expect: "Fanpage hết hạn token ⇒ 'Fanpage … cần kết nối lại' + lý do + nút Kết nối lại; kênh YouTube mất quyền ở Đăng đa kênh cũng vậy",
    async run() {
      const a = await open("/connections?muc=facebook")
      let fb
      try {
        const notice = a.page.getByTestId("reconnect-notice")
        fb = (await visible(notice)) && /cần kết nối lại/.test(await notice.first().innerText()) && (await visible(notice.getByRole("button", { name: /Kết nối lại/ })))
      } finally { await a.close() }
      const b = await open("/social?tab=channels")
      let social
      try {
        const notice = b.page.getByTestId("reconnect-notice")
        social = (await visible(notice)) && /YouTube|Trinity Coffee TV/.test(await notice.first().innerText())
      } finally { await b.close() }
      return { ok: fb && social, actual: `Fanpage: ${fb ? "có thông báo + nút" : "THIẾU"}; Đăng đa kênh: ${social ? "có thông báo" : "THIẾU"}` }
    },
  },
  {
    name: "dang-bai-loi",
    expect: "Bài đăng lỗi ⇒ 'Không đăng được lên <kênh>: <lý do>' + nút Đăng lại; bấm ⇒ gọi lệnh đăng lại",
    async run() {
      const h = await open("/social?tab=posts", { "/^POST \\/social\\/targets\\/\\d+\\/retry$/": json(200, {}) })
      try {
        const t = await text(h.page)
        const said = /Không đăng được lên Trinity Coffee TV: YouTube từ chối/.test(t)
        const btn = h.page.getByRole("button", { name: /Đăng lại/ })
        const has = await visible(btn)
        if (has) await btn.first().click()
        await h.page.waitForTimeout(800)
        const called = h.api.log.some((l) => /^POST \/social\/.*retry/.test(l))
        return { ok: said && has && called, actual: `câu lỗi: ${said ? "đúng" : "THIẾU"}; nút: ${has ? "có" : "THIẾU"}; gọi đăng lại: ${called ? "có" : "KHÔNG"}` }
      } finally { await h.close() }
    },
  },
  {
    name: "hoan-tac-xoa-khach",
    expect: "Xoá khách ⇒ gửi DELETE ngay, khách biến khỏi danh sách + toast Hoàn tác; bấm Hoàn tác ⇒ gọi POST /contacts/:id/restore (khôi phục phía máy chủ)",
    async run() {
      // Máy chủ giả có trạng thái: xoá thì khách biến khỏi danh sách, khôi phục thì hiện lại.
      const gone = new Set()
      const h = await open("/contacts", {
        "/^DELETE \\/contacts\\/\\d+$/": (req) => (gone.add(req.path.split("/")[2]), { status: 200, json: { success: true } }),
        "/^POST \\/contacts\\/\\d+\\/restore$/": (req) => (gone.delete(req.path.split("/")[2]), { status: 200, json: { success: true } }),
        "GET /contacts": (req) => {
          const base = handle(req)
          return { ...base, json: { ...base.json, data: base.json.data.filter((c) => !gone.has(String(c.id))) } }
        },
      })
      try {
        const box = h.page.getByRole("checkbox", { name: /^Chọn khách hàng / }).first()
        const label = (await box.getAttribute("aria-label")) ?? ""
        const name = label.replace(/^Chọn khách hàng /, "")
        await box.check()
        await h.page.getByRole("button", { name: /Xoá đã chọn/ }).first().click()
        await h.page.getByRole("button", { name: "Xoá khách hàng" }).click()
        await h.page.waitForTimeout(800)
        const sent = h.api.log.some((l) => /^DELETE \/contacts\/\d+$/.test(l))
        const hidden = !(await h.page.locator("main").last().innerText()).includes(name)
        await h.page.getByRole("button", { name: "Hoàn tác" }).click()
        await h.page.waitForTimeout(800)
        const restored = h.api.log.some((l) => /^POST \/contacts\/\d+\/restore$/.test(l))
        return {
          ok: sent && hidden && restored,
          actual: `gửi DELETE ngay: ${sent ? "có" : "KHÔNG"}; ẩn khỏi danh sách: ${hidden ? "có" : "KHÔNG"}; Hoàn tác gọi restore: ${restored ? "có" : "KHÔNG"}`,
        }
      } finally { await h.close() }
    },
  },
  {
    name: "hoan-tac-xoa-nhap",
    expect: "Xoá bài nháp ⇒ biến mất ngay + toast Hoàn tác; bấm Hoàn tác ⇒ hiện lại, KHÔNG gửi DELETE; xoá lại và chờ 5 giây ⇒ gửi DELETE",
    async run() {
      const h = await open("/social?tab=drafts", { "/^DELETE \\/social\\/drafts\\/\\d+$/": json(200, {}) })
      try {
        const before = await h.page.getByRole("button", { name: /^Xoá/ }).count()
        await h.page.getByRole("button", { name: /^Xoá/ }).first().click()
        await h.page.getByRole("button", { name: "Xoá nháp" }).click()
        // Chờ tới 3 giây cho lần vẽ lại (CI chậm hơn máy dev) — vẫn trong cửa sổ 5 giây, chưa gửi DELETE.
        let hidden = false
        for (let i = 0; i < 15 && !hidden; i++) {
          await h.page.waitForTimeout(200)
          hidden = (await h.page.getByRole("button", { name: /^Xoá/ }).count()) === before - 1
        }
        await h.page.getByRole("button", { name: "Hoàn tác" }).click()
        await h.page.waitForTimeout(1500)
        const back = (await h.page.getByRole("button", { name: /^Xoá/ }).count()) === before
        await h.page.waitForTimeout(4500)
        const noDelete = !h.api.log.some((l) => l.startsWith("DELETE /social/drafts"))
        await h.page.getByRole("button", { name: /^Xoá/ }).first().click()
        await h.page.getByRole("button", { name: "Xoá nháp" }).click()
        await h.page.waitForTimeout(5800)
        const deleted = h.api.log.some((l) => l.startsWith("DELETE /social/drafts"))
        return {
          ok: hidden && back && noDelete && deleted,
          actual: `ẩn ngay: ${hidden ? "có" : "KHÔNG"}; Hoàn tác hiện lại: ${back ? "có" : "KHÔNG"}; không gửi khi hoàn tác: ${noDelete ? "đúng" : "SAI"}; hết 5 giây gửi DELETE: ${deleted ? "có" : "KHÔNG"}`,
        }
      } finally { await h.close() }
    },
  },
]

if (process.argv[1]?.endsWith("break-it.mjs")) {
  const only = process.argv.slice(2)
  const rows = []
  for (const c of CASES.filter((c) => !only.length || only.includes(c.name))) {
    let r
    try {
      r = await c.run()
    } catch (e) {
      r = { ok: false, actual: `lỗi khi chạy: ${String(e).split("\n")[0].slice(0, 160)}` }
    }
    rows.push({ name: c.name, expect: c.expect, ...r })
    console.error(`${r.ok ? "✅" : "❌"} ${c.name} — ${r.actual}`)
  }
  console.log("\n| Tình huống | Mong đợi | Thực tế | Đạt |\n|---|---|---|---|")
  for (const r of rows) console.log(`| \`${r.name}\` | ${r.expect} | ${r.actual.replace(/\|/g, "/")} | ${r.ok ? "✅" : "❌"} |`)
  process.exitCode = rows.every((r) => r.ok) ? 0 : 1
}
