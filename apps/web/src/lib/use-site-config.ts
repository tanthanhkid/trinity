"use client"

import { useEffect, useState } from "react"
import { SITE_CONFIG_EVENT, fetchSiteConfig, readSiteConfig, type SiteConfig } from "./site-config"

/**
 * Cấu hình lúc chạy cho component client. Lần vẽ đầu luôn `null` (khớp HTML dựng sẵn, tránh lệch hydrate); sau đó lấy bản
 * script `<head>` đã nạp, không có thì gọi `GET /site-config` một lần.
 */
export function useSiteConfig(): SiteConfig | null {
  const [cfg, setCfg] = useState<SiteConfig | null>(null)
  useEffect(() => {
    const onLoaded = () => {
      const c = readSiteConfig()
      if (c) setCfg(c)
    }
    window.addEventListener(SITE_CONFIG_EVENT, onLoaded)
    const preloaded = readSiteConfig()
    let alive = true
    if (preloaded) setCfg(preloaded)
    else
      void fetchSiteConfig().then((c) => {
        if (alive && c) setCfg(c)
      })
    return () => {
      alive = false
      window.removeEventListener(SITE_CONFIG_EVENT, onLoaded)
    }
  }, [])
  return cfg
}
