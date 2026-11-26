import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone: đóng gói cho máy chủ tự quản (Dockerfile / pm2).
  output: "standalone",
  devIndicators: false,
  compress: true,
  poweredByHeader: false,
  reactStrictMode: true,
  images: {
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 60,
  },
  ...(process.env.NODE_ENV !== 'production' && {
    experimental: {
      allowDevelopmentBuild: true,
    },
  }),
  // OAuth/MCP well-known. Reverse proxy chỉ chuyển `/api/v1/` → monolith, còn lại → Next, nên 2 URL khám phá nằm ở GỐC
  // (RFC 8414 §3.1 / RFC 9728 §3.1: `/.well-known/<loại>` + path của issuer/resource) phải được Next chuyển tiếp sang monolith.
  // Đích mặc định = monolith cục bộ :4000 (cùng giả định `LOCAL_ROUTES` ở app/api/v1/[...path]/route.ts).
  rewrites: async () => {
    const monolith = (process.env.MONOLITH_INTERNAL_URL ?? "http://127.0.0.1:4000").replace(/\/+$/, "");
    const wellKnown = (source: string, destination: string) => [
      { source, destination: `${monolith}${destination}` },
      { source: `${source}/:path*`, destination: `${monolith}${destination}` },
    ];
    return {
      beforeFiles: [
        ...wellKnown("/.well-known/oauth-authorization-server", "/api/v1/oauth/.well-known/oauth-authorization-server"),
        ...wellKnown("/.well-known/oauth-protected-resource", "/api/v1/oauth/protected-resource"),
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  // `/assistant` chuyển sang Cài đặt › Kết nối & AI — nơi kết nối ChatGPT/Claude/agent khác qua MCP.
  redirects: async () => [
    { source: "/assistant", destination: "/settings?tab=integrations", permanent: false },
    { source: "/assistant/:path*", destination: "/settings?tab=integrations", permanent: false },
  ],
  headers: async () => [
    // màn đồng ý OAuth KHÔNG được nhúng vào khung của trang khác (clickjacking: phủ lớp trong suốt lên nút "Cho phép").
    {
      source: "/oauth/authorize",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    },
    {
      // Tệp trong /public có tên cố định (logo, font) nên KHÔNG immutable: thay logo tại chỗ phải tới được người dùng trong ngày.
      source: "/:all*(svg|jpg|jpeg|png|webp|avif|ico|woff|woff2)",
      headers: [
        { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
      ],
    },
    {
      source: "/_next/static/:path*",
      headers: [
        { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
      ],
    },
  ],
};

export default nextConfig;
