/**
 * Cấu hình lúc chạy do máy chủ trả ở `GET /api/v1/site-config` (K27, chỉ có ở Rust): thông tin pháp lý, chế độ realtime, cờ ds-v2.
 *
 * Đổi env rồi khởi động lại binary là đổi theo, không build lại web. Script `SITE_CONFIG_INIT_SCRIPT` trong `<head>` nạp
 * cấu hình KHÔNG đồng bộ (cache localStorage áp ngay + `fetch` song song) vào `window.__TRINITY_SITE_CONFIG__`.
 * Không nạp được (máy chủ cũ không có route này, mất mạng) ⇒ lùi về `NEXT_PUBLIC_*` lúc build.
 * Không import module client nào ở đây: file được dùng cả ở server component (layout) lẫn module-level (`design-system-flags`).
 */
export const SITE_CONFIG_URL = "/api/v1/site-config"
export const SITE_CONFIG_GLOBAL = "__TRINITY_SITE_CONFIG__"

export interface SiteConfigLegal {
  contact_email: string | null
  company_name: string | null
  company_name_en: string | null
  company_tax_id: string | null
  company_address: string | null
  company_phone: string | null
}

export interface SiteConfig {
  legal: SiteConfigLegal
  realtime_mode: "socket" | "poll"
  ds_v2: boolean
}

const LEGAL_KEYS: (keyof SiteConfigLegal)[] = [
  "contact_email",
  "company_name",
  "company_name_en",
  "company_tax_id",
  "company_address",
  "company_phone",
]

/** Chuẩn hoá phản hồi; hình dạng lạ (null, mảng, kiểu sai) ⇒ `null`. Trường pháp lý rỗng/sai kiểu ⇒ `null`. */
export function parseSiteConfig(raw: unknown): SiteConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const l = o.legal && typeof o.legal === "object" && !Array.isArray(o.legal) ? (o.legal as Record<string, unknown>) : {}
  const legal = {} as SiteConfigLegal
  for (const k of LEGAL_KEYS) {
    const v = l[k]
    legal[k] = typeof v === "string" && v.trim() ? v.trim() : null
  }
  return { legal, realtime_mode: o.realtime_mode === "poll" ? "poll" : "socket", ds_v2: o.ds_v2 === true }
}

/** Cấu hình do script `<head>` nạp sẵn; `null` ở server hoặc khi chưa/không nạp được. */
export function readSiteConfig(): SiteConfig | null {
  if (typeof window === "undefined") return null
  return parseSiteConfig((window as unknown as Record<string, unknown>)[SITE_CONFIG_GLOBAL])
}

/** Nạp bất đồng bộ (trang không đi qua script head, hoặc nạp lại). Lỗi ⇒ `null`, không ném. */
export async function fetchSiteConfig(fetcher: typeof fetch = fetch): Promise<SiteConfig | null> {
  try {
    const res = await fetcher(SITE_CONFIG_URL, { headers: { Accept: "application/json" } })
    if (!res.ok) return null
    return parseSiteConfig(await res.json())
  } catch {
    return null
  }
}

/** `ds_v2` hiệu lực: cấu hình lúc chạy nếu có, không thì cờ build `NEXT_PUBLIC_DS_V2`. */
export function resolveDsV2(): boolean {
  const cfg = readSiteConfig()
  return cfg ? cfg.ds_v2 : process.env.NEXT_PUBLIC_DS_V2 === "true"
}

/** `poll` hiệu lực: cấu hình lúc chạy nếu có, không thì cờ build `NEXT_PUBLIC_REALTIME_MODE`. */
export function resolvePollMode(): boolean {
  const cfg = readSiteConfig()
  return cfg ? cfg.realtime_mode === "poll" : process.env.NEXT_PUBLIC_REALTIME_MODE === "poll"
}

export const SITE_CONFIG_CACHE_KEY = "trinity.site-config.v1"
export const SITE_CONFIG_EVENT = "trinity:site-config"

/**
 * Chạy trong `<head>` nhưng KHÔNG chặn: (1) áp ngay bản cache ở localStorage (lần thăm sau đã đúng cờ ở lần vẽ đầu, không nháy);
 * (2) gọi `fetch` bất đồng bộ song song với bundle/bootstrap, về thì lưu cache, áp lại `data-ds` và phát sự kiện
 * `SITE_CONFIG_EVENT` cho `useSiteConfig`. Lần đầu chưa có cache ⇒ lùi về `NEXT_PUBLIC_*` lúc build tới khi fetch về
 * (hằng số module như `DS_V2_ENABLED` chỉ đổi ở lần nạp sau). Mọi lỗi đều nuốt.
 */
export const SITE_CONFIG_INIT_SCRIPT = `(function(){var G='${SITE_CONFIG_GLOBAL}',K='${SITE_CONFIG_CACHE_KEY}',r=document.documentElement;function ap(c){window[G]=c;if(c.ds_v2===true)r.setAttribute('data-ds','v2');else r.removeAttribute('data-ds')}try{var s=localStorage.getItem(K);if(s){var c=JSON.parse(s);if(c&&typeof c==='object'&&!Array.isArray(c))ap(c)}}catch(e){}try{fetch('${SITE_CONFIG_URL}',{headers:{Accept:'application/json'}}).then(function(x){return x.ok?x.json():null}).then(function(c){if(!c||typeof c!=='object'||Array.isArray(c))return;try{localStorage.setItem(K,JSON.stringify(c))}catch(e){}ap(c);window.dispatchEvent(new Event('${SITE_CONFIG_EVENT}'))}).catch(function(){})}catch(e){}})();`
