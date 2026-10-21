// Dò các API một trang gọi khi mở (dùng khi viết dữ liệu giả cho fixtures.mjs). Chạy: node e2e/premium/probe.mjs /dashboard
import { BASE_URL, launch, mockApi, signIn } from "./harness.mjs"
import { handle } from "./fixtures.mjs"

const path = process.argv[2] ?? "/dashboard"
const { context, page, cdp, close } = await launch()
await signIn(context)
const { log } = await mockApi(cdp, (req) => handle(req))
const errors = []
page.on("pageerror", (e) => errors.push(e.message))
await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle", timeout: 180_000 }).catch((e) => errors.push(String(e)))
await page.waitForTimeout(3000)
console.log(`URL: ${page.url()}`)
console.log([...new Set(log)].join("\n"))
console.log("--- lỗi trang:", errors.slice(0, 5))
console.log("--- chữ:", (await page.locator("main").last().innerText().catch(() => "")).slice(0, 600))
await close()
