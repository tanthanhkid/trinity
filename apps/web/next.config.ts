import type { NextConfig } from "next";

/**
 * Web tĩnh (W02b): `next build` xuất thẳng ra `out/` (`output: "export"`), Rust phục vụ (K18). Không còn máy chủ Next:
 * không `standalone`, không `proxy.ts`, không route handler (`/api/v1`, `/uploads`, `/api/build-id`, `/api/fe-logging`).
 * Việc của chúng do Rust làm: `rewrites/redirects/headers` cũ (`/.well-known`, `/assistant`, CSP màn OAuth, cache tệp tĩnh)
 * và luật điều hướng của `proxy.ts` nằm ở `trinity-http::web` (K18). `distDir` riêng để `.next` của bản dev không lẫn.
 */
const nextConfig: NextConfig = {
  output: "export",
  distDir: ".next-export",
  env: { NEXT_PUBLIC_STATIC_EXPORT: "1" },
  devIndicators: false,
  compress: true,
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
  ...(process.env.NODE_ENV !== 'production' && {
    experimental: {
      allowDevelopmentBuild: true,
    },
  }),
};

export default nextConfig;
