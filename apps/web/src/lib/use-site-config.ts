"use client"

import { useEffect, useState } from "react"
import { fetchSiteConfig, readSiteConfig, type SiteConfig } from "./site-config"

/**
 * Cấu hình lúc chạy cho component client. Lần vẽ đầu luôn `null` (khớp HTML dựng sẵn, tránh lệch hydrate); sau đó lấy bản
 * script `<head>` đã nạp, không có thì gọi `GET /site-config` một lần.
 */
export function useSiteConfig(): SiteConfig | null {
  const [cfg, setCfg] = useState<SiteConfig | null>(null)
  useEffect(() => {
    const preloaded = readSiteConfig()
    if (preloaded) {
      setCfg(preloaded)
      return
    }
    let alive = true
    void fetchSiteConfig().then((c) => {
      if (alive && c) setCfg(c)
    })
    return () => {
      alive = false
    }
  }, [])
  return cfg
}
