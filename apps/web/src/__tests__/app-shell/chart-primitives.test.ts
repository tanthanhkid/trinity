import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  monotonePath,
  formatChartNumber,
  niceCeil,
  niceTicks,
  CHART_SEQ_ASC,
  type PlotPoint,
} from "@/components/app-shell/charts/chart-data"
import { xLabelStep } from "@/components/app-shell/charts/plot-frame"
import { columnTotals } from "@/components/app-shell/charts/bar-v"
import { cellColor, shadeStep } from "@/components/app-shell/charts/heatmap"
import { inkOn, CHART_NEUTRAL, CHART_STATUS } from "@/components/app-shell/charts/chart-colors"
import { CHART_PALETTE } from "@/components/app-shell/charts/chart-data"
import {
  formatPercent,
  statusColor,
  statusLabel,
} from "@/components/app-shell/charts/radial"

/* =============================================================================
 * Khoá phần SỐ của 4 primitive biểu đồ. Cùng nguyên tắc với `chart-data.test.ts`: phần dễ sai của một
 * biểu đồ là dữ liệu, không phải SVG — nên tầng thuần test được mà không render.
 * ========================================================================== */

// ── công thức WCAG 2.1 (bản sao cục bộ như `contrast.test.ts`) ────────────
function channelToLinear(value255: number): number {
  const c = value255 / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "")
  return (
    0.2126 * channelToLinear(Number.parseInt(h.slice(0, 2), 16)) +
    0.7152 * channelToLinear(Number.parseInt(h.slice(2, 4), 16)) +
    0.0722 * channelToLinear(Number.parseInt(h.slice(4, 6), 16))
  )
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const TOKENS_CSS = readFileSync(
  join(__dirname, "../../styles/app-tokens.css"),
  "utf8",
)

/** Giá trị thật của một token trong khối v2 — không hardcode hex vào test. */
function tokenHex(name: string): string {
  const start = TOKENS_CSS.indexOf('html:root[data-ui="app"]')
  const block = TOKENS_CSS.slice(start, TOKENS_CSS.indexOf("\n}", start))
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block)
  if (!m) throw new Error(`không tìm thấy token ${name}`)
  return m[1].toLowerCase()
}

/** `CHART_SEQ_ASC` là mảng `var(--…)`; đổi về hex thật để đo tương phản. */
const SEQ_HEX = CHART_SEQ_ASC.map((v) =>
  tokenHex(v.replace("var(", "").replace(")", "")),
)

// ═══════════════════════════════════════════════════════════════════════════
describe("monotonePath — đường cong KHÔNG được vẽ ra giá trị không tồn tại", () => {
  /**
   * Tách chuỗi `d` thành các đoạn Bézier bậc 3 rồi LẤY MẪU đường cong thật.
   *
   * 🔴 Bản test đầu của chính khối này soi toạ độ y của ĐIỂM ĐIỀU KHIỂN và đòi
   * chúng đơn điệu — SAI về toán: điều kiện Fritsch–Carlson bảo đảm ĐƯỜNG CONG
   * đơn điệu, không bảo đảm đa giác điều khiển đơn điệu (đoạn 40→42 có
   * c1y=41,08 > c2y=40,32 mà y'(t) vẫn dương trên toàn đoạn). Muốn kiểm bất
   * biến hình học thì phải kiểm trên chính đường cong.
   */
  interface Seg {
    p0: PlotPoint
    c1: PlotPoint
    c2: PlotPoint
    p3: PlotPoint
  }

  function parseSegments(d: string): Seg[] {
    const [head, ...curves] = d.split("C")
    const pair = (t: string): PlotPoint => {
      const [x, y] = t.trim().split(",").map(Number)
      return { x, y }
    }
    let cursor = pair(head.replace("M", ""))
    const out: Seg[] = []
    for (const c of curves) {
      const [c1, c2, p3] = c.trim().split(" ").map(pair)
      out.push({ p0: cursor, c1, c2, p3 })
      cursor = p3
    }
    return out
  }

  const bezierY = (s: Seg, t: number): number => {
    const u = 1 - t
    return (
      u * u * u * s.p0.y +
      3 * u * u * t * s.c1.y +
      3 * u * t * t * s.c2.y +
      t * t * t * s.p3.y
    )
  }

  function sampleY(d: string, steps = 60): number[] {
    const out: number[] = []
    for (const seg of parseSegments(d)) {
      for (let i = 0; i <= steps; i++) out.push(bezierY(seg, i / steps))
    }
    return out
  }

  it("🔴 KHÔNG vượt biên: mỗi đoạn nằm trong khoảng y của ĐÚNG 2 đầu mút của nó", () => {
    // Đây là bất biến biện minh cho việc dùng monotone cubic thay spline
    // "smooth" mặc định: chuỗi 0 → 120 → 0 với spline thường uốn xuống DƯỚI 0,
    // tức biểu đồ vẽ ra số âm ở nơi dữ liệu thật là số đếm không âm.
    const points: PlotPoint[] = [
      { x: 0, y: 100 },
      { x: 25, y: 0 },
      { x: 50, y: 100 },
      { x: 75, y: 10 },
      { x: 100, y: 100 },
    ]
    for (const seg of parseSegments(monotonePath(points))) {
      const lo = Math.min(seg.p0.y, seg.p3.y)
      const hi = Math.max(seg.p0.y, seg.p3.y)
      for (let i = 0; i <= 60; i++) {
        const y = bezierY(seg, i / 60)
        expect(y).toBeGreaterThanOrEqual(lo - 1e-6)
        expect(y).toBeLessThanOrEqual(hi + 1e-6)
      }
    }
  })

  it("chuỗi phẳng (mọi giá trị bằng nhau) cho đường THẲNG, không gợn sóng", () => {
    const d = monotonePath([
      { x: 0, y: 50 },
      { x: 50, y: 50 },
      { x: 100, y: 50 },
    ])
    for (const y of sampleY(d)) expect(y).toBeCloseTo(50, 9)
  })

  it("chuỗi tăng đều giữ ĐƠN ĐIỆU trên toàn đường cong", () => {
    const pts: PlotPoint[] = [0, 10, 40, 42, 90].map((y, i) => ({ x: i * 25, y }))
    const ys = sampleY(monotonePath(pts))
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] - 1e-6)
    }
  })

  it("chuỗi giảm đều cũng đơn điệu (đối xứng chiều ngược)", () => {
    const pts: PlotPoint[] = [90, 42, 40, 10, 0].map((y, i) => ({ x: i * 25, y }))
    const ys = sampleY(monotonePath(pts))
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeLessThanOrEqual(ys[i - 1] + 1e-6)
    }
  })

  it("một điểm vọt lên giữa chuỗi phẳng KHÔNG kéo hàng xóm xuống dưới đáy", () => {
    // Ca thật hay gặp: 13 ngày im ắng rồi 1 ngày bùng. Spline thường sẽ đào
    // một hố âm ngay trước/sau đỉnh.
    const pts: PlotPoint[] = [5, 5, 5, 5, 120, 5, 5].map((y, i) => ({ x: i * 10, y }))
    for (const y of sampleY(monotonePath(pts))) {
      expect(y).toBeGreaterThanOrEqual(5 - 1e-6)
      expect(y).toBeLessThanOrEqual(120 + 1e-6)
    }
  })

  it("🔴 kẹp Fritsch–Carlson: 2 bộ điểm KÍCH đúng vòng kẹp (nới bán kính là đỏ)", () => {
    // 5 ca ở trên đều xanh khi nới bán kính kẹp từ 3 lên 4 — ca zigzag có mọi
    // tiếp tuyến trong = 0 nên vòng kẹp không bao giờ chạy, còn ca tăng đều thì
    // miền đơn điệu thật rộng hơn đường tròn r=3. Hai bộ dưới đây vượt biên
    // ngay khi bán kính bị nới, nên khoá được chính vòng kẹp.
    for (const ys of [
      [67, 94, 32, 23, 28],
      [27, 94, 104, 41],
    ]) {
      const pts: PlotPoint[] = ys.map((y, i) => ({ x: i * 25, y }))
      for (const seg of parseSegments(monotonePath(pts))) {
        const lo = Math.min(seg.p0.y, seg.p3.y)
        const hi = Math.max(seg.p0.y, seg.p3.y)
        for (let i = 0; i <= 60; i++) {
          const y = bezierY(seg, i / 60)
          expect(y).toBeGreaterThanOrEqual(lo - 1e-6)
          expect(y).toBeLessThanOrEqual(hi + 1e-6)
        }
      }
    }
  })

  it("🔴 fuzz 3.000 chuỗi (seed cố định) — không đoạn nào vượt khoảng 2 đầu mút", () => {
    // Sinh số giả-ngẫu nhiên tất định (LCG) để chạy lại luôn cho cùng kết quả:
    // test fuzz mà không tất định thì đỏ lúc được lúc không, không ai tin.
    let seed = 20260911
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let t = 0; t < 3000; t++) {
      const n = 3 + Math.floor(rnd() * 10)
      const pts: PlotPoint[] = Array.from({ length: n }, (_, i) => ({
        x: i * 10,
        y: Math.round(rnd() * 120),
      }))
      for (const seg of parseSegments(monotonePath(pts))) {
        const lo = Math.min(seg.p0.y, seg.p3.y)
        const hi = Math.max(seg.p0.y, seg.p3.y)
        for (let k = 0; k <= 20; k++) {
          const y = bezierY(seg, k / 20)
          expect(y).toBeGreaterThanOrEqual(lo - 1e-6)
          expect(y).toBeLessThanOrEqual(hi + 1e-6)
        }
      }
    }
  }, 60_000) // 3.000 chuỗi: runner CI chậm (vitest 4 đo ~12 giây) — vượt mặc định 5 giây

  it("0 điểm → chuỗi rỗng; 1 điểm → chỉ lệnh M (caller tự vẽ chấm)", () => {
    expect(monotonePath([])).toBe("")
    expect(monotonePath([{ x: 3, y: 7 }])).toBe("M3,7")
  })

  it("2 điểm trùng hoành độ không sinh NaN (dx = 0)", () => {
    const d = monotonePath([
      { x: 50, y: 10 },
      { x: 50, y: 90 },
    ])
    expect(d).not.toContain("NaN")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe("columnTotals — cận trên trục của cột XẾP CHỒNG là TỔNG, không phải max lát", () => {
  const series = [
    { name: "A", values: [3, 1] },
    { name: "B", values: [4, 1] },
  ]

  it("🔴 xếp chồng lấy tổng mỗi cột — lấy nhầm từng lát thì đỉnh cột tràn ra ngoài khung", () => {
    expect(columnTotals(2, series, true)).toEqual([7, 2])
    expect(niceCeil(columnTotals(2, series, true))).toBeGreaterThanOrEqual(7)
  })

  it("nhóm cạnh nhau lấy từng giá trị rời", () => {
    expect(columnTotals(2, series, false)).toEqual([3, 1, 4, 1])
  })

  it("bỏ qua giá trị âm/NaN khi cộng (dữ liệu BE có thể trả null)", () => {
    const dirty = [{ name: "A", values: [Number.NaN, -5, 2] }]
    expect(columnTotals(3, dirty, true)).toEqual([0, 0, 2])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe("xLabelStep — thưa nhãn trục X để chữ không đè nhau", () => {
  it("ít mốc thì hiện đủ", () => {
    expect(xLabelStep(6)).toBe(1)
    expect(xLabelStep(8)).toBe(1)
  })

  it("14 ngày / 24 giờ / 30 ngày đều thưa xuống ≤ 8 nhãn", () => {
    for (const n of [14, 24, 30, 90]) {
      const step = xLabelStep(n)
      expect(Math.ceil(n / step)).toBeLessThanOrEqual(8)
    }
  })

  it("không bao giờ trả 0 (chia cho 0 ⇒ vòng lặp render vô hạn nhãn)", () => {
    for (const n of [0, 1, 2, 1000]) expect(xLabelStep(n)).toBeGreaterThanOrEqual(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe("shadeStep — bậc đậm của ô heatmap", () => {
  it("luôn nằm trong dải màu, không trỏ ra ngoài mảng", () => {
    for (const [v, max] of [
      [0, 0],
      [5, 0],
      [0, 100],
      [1, 100],
      [100, 100],
      [500, 100],
      [Number.NaN, 100],
    ]) {
      const s = shadeStep(v, max)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThan(CHART_SEQ_ASC.length)
    }
  })

  it("giá trị lớn nhất ăn bậc đậm nhất, giá trị nhỏ nhất > 0 ăn bậc nhạt nhất", () => {
    expect(shadeStep(100, 100)).toBe(CHART_SEQ_ASC.length - 1)
    expect(shadeStep(1, 100)).toBe(0)
  })

  it("🔴 giá trị LỚN hơn phải ra ô TỐI hơn — khoá chiều của dải màu", () => {
    // Bản đầu của heatmap dùng nhầm `CHART_SEQ` (mảng xếp ĐẬM TRƯỚC, dành
    // cho xếp hạng) nên tô giá trị lớn thành màu NHẠT: hình nói ngược hẳn số
    // mà không lỗi nào phát ra. Đo độ chói thay vì so tên biến — đảo mảng hay
    // đảo chỉ số đều bị bắt.
    const lum = (token: string) =>
      relativeLuminance(tokenHex(token.replace("var(", "").replace(")", "")))
    let prev = Number.POSITIVE_INFINITY
    for (const v of [1, 20, 40, 60, 80, 100]) {
      const l = lum(cellColor(v, 100))
      expect(l).toBeLessThan(prev)
      prev = l
    }
  })

  it("ô rỗng dùng nền trung tính, KHÔNG phải bậc nhạt nhất của dải", () => {
    // Ô 0 và ô "có ít" là 2 nghĩa khác nhau nên không được dùng CHUNG một màu.
    // ⚠️ Đo thật: 2 màu này chỉ chênh 1,14:1 — mắt gần như không phân biệt
    // được, nên thứ THỰC SỰ tách 2 ca là con số in trong ô (xem docblock
    // `heatmap.tsx`), không phải màu nền.
    expect(cellColor(0, 100)).toBe("var(--color-app-surface-2)")
    expect(cellColor(1, 100)).not.toBe(cellColor(0, 100))
  })

  it("đơn điệu — giá trị lớn hơn không bao giờ ra bậc nhạt hơn", () => {
    let prev = -1
    for (let v = 0; v <= 100; v++) {
      const s = shadeStep(v, 100)
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe("🔴 heatmap — chữ trên nền MÀU-THEO-DỮ-LIỆU phải đạt AA ở MỌI bậc", () => {
  // Bản nháp của primitive này đặt ranh giới chữ trắng ở bậc 5 theo cảm giác
  // "nhìn đã đủ đậm" — đo ra chỉ 3,39:1. Test này khoá ranh giới ĐO ĐƯỢC.
  const NAVY = tokenHex("--color-app-navy")
  const WHITE = "#ffffff"
  const WHITE_INK_FROM_STEP = 5

  it.each(SEQ_HEX.map((hex, i) => [i, hex] as const))(
    "bậc %i (%s) đạt ≥ 4,5:1 với đúng màu chữ mà component chọn",
    (i, hex) => {
      const ink = i >= WHITE_INK_FROM_STEP ? WHITE : NAVY
      expect(contrast(ink, hex)).toBeGreaterThanOrEqual(4.5)
    },
  )

  it("ranh giới đặt ĐÚNG chỗ: lệch 1 bậc về bên nào cũng phá AA", () => {
    // Bậc ngay trước ranh giới: chữ TRẮNG sẽ trượt (đó là lỗi bản nháp).
    expect(
      contrast(WHITE, SEQ_HEX[WHITE_INK_FROM_STEP - 1]),
    ).toBeLessThan(4.5)
    // Bậc tại ranh giới: chữ NAVY sẽ trượt ⇒ không thể lùi ranh giới xuống.
    expect(contrast(NAVY, SEQ_HEX[WHITE_INK_FROM_STEP])).toBeLessThan(4.5)
  })

  it("hằng trong source khớp ranh giới đã đo (đổi dải màu mà quên đo lại → đỏ)", () => {
    const src = readFileSync(
      join(__dirname, "../../components/app-shell/charts/heatmap.tsx"),
      "utf8",
    )
    expect(src).toContain(`const WHITE_INK_FROM_STEP = ${WHITE_INK_FROM_STEP}`)
  })

  it("ô rỗng: navy trên nền surface-2 vẫn đạt AA", () => {
    expect(
      contrast(NAVY, tokenHex("--color-app-surface-2")),
    ).toBeGreaterThanOrEqual(4.5)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe("ShellRadial — số phần trăm và ngưỡng trạng thái", () => {
  it("dấu phẩy kiểu Việt, 1 chữ số thập phân", () => {
    expect(formatPercent(52.64)).toBe("52,6%")
    expect(formatPercent(55)).toBe("55%")
    expect(formatPercent(0)).toBe("0%")
  })

  it("🔴 vượt 100% vẫn in SỐ THẬT (cung mới bị kẹp, con số thì không)", () => {
    expect(formatPercent(103.2)).toBe("103,2%")
  })

  it("giá trị không hợp lệ ra '—', KHÔNG ra '0%' (0% là một kết quả có thật)", () => {
    expect(formatPercent(Number.NaN)).toBe("—")
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("—")
  })

  it("màu trạng thái LUÔN đi kèm nhãn chữ cùng ngưỡng (WCAG 1.4.1)", () => {
    for (const [pct, color, label] of [
      [95, "good", "đạt"],
      [85, "warn", "cần theo dõi"],
      [40, "bad", "dưới ngưỡng"],
    ] as const) {
      expect(statusColor(pct, 90, 80)).toBe(`var(--color-app-chart-${color})`)
      expect(statusLabel(pct, 90, 80)).toBe(label)
    }
  })

  it("3 token trạng thái đạt 3:1 (ĐỒ HOẠ) trên đúng nền thẻ", () => {
    // Bản test đầu so với `--color-app-surface-2` ở ngưỡng CHỮ 4,5:1 — sai cả
    // nền lẫn vai trò: thẻ biểu đồ nền `--card` (trắng), và 3 token này tô NÉT
    // cung/thanh nên ngưỡng đúng là 1.4.11 (3:1).
    const card = "#ffffff"
    for (const name of ["good", "warn", "bad"]) {
      expect(
        contrast(tokenHex(`--color-app-chart-${name}`), card),
      ).toBeGreaterThanOrEqual(3)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe("trục dùng chung — niceCeil/niceTicks vẫn đúng sau khi dời file", () => {
  it("re-export ở bar-h giữ nguyên API cũ (không phá call-site/test cũ)", async () => {
    const barH = await import("@/components/app-shell/charts/bar-h")
    expect(barH.niceCeil([7])).toBe(niceCeil([7]))
    expect(barH.niceTicks(10)).toEqual(niceTicks(10))
  })

  it("nhóm hàng nghìn kiểu Việt", () => {
    expect(formatChartNumber(1234567)).toBe("1.234.567")
    expect(formatChartNumber(0)).toBe("0")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe("🔴 inkOn — số IN ĐÈ lên cột màu phải đọc được ở MỌI màu", () => {
  const resolve = (token: string) =>
    token === "#ffffff"
      ? "#ffffff"
      : tokenHex(token.replace("var(", "").replace(")", ""))

  const BAR_COLORS = [
    ...CHART_PALETTE,
    CHART_NEUTRAL,
    CHART_STATUS.good,
    CHART_STATUS.warn,
    CHART_STATUS.bad,
  ]

  it.each(BAR_COLORS)("%s: màu chữ mà inkOn chọn đạt AA 4,5:1", (color) => {
    expect(contrast(resolve(inkOn(color)), resolve(color))).toBeGreaterThanOrEqual(4.5)
  })

  it("KHÔNG có màu chữ nào dùng chung được cho cả 10 nền — đó là lý do hàm này tồn tại", () => {
    // Nếu một ngày cả 10 nền cùng đạt AA với trắng (hoặc cùng với navy) thì
    // `inkOn` thành thừa. Test này nói rõ điều kiện đó CHƯA đúng, để không ai
    // "đơn giản hoá" về `fill="#ffffff"` như trước đây.
    const fails = (ink: string) =>
      BAR_COLORS.filter((c) => contrast(resolve(ink), resolve(c)) < 4.5).length
    expect(fails("#ffffff")).toBeGreaterThan(0)
    expect(fails("var(--color-app-navy)")).toBeGreaterThan(0)
  })

  it("màu lạ (ngoài bảng) rơi về navy — phỏng đoán an toàn cho nền sáng", () => {
    expect(inkOn("var(--khong-ton-tai)")).toBe("var(--color-app-navy)")
  })
})
