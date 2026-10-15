import path from "node:path";
import type { NextConfig } from "next";
import { isServerlessRuntime, serverlessRewrites } from "./src/lib/serverless-runtime";

// Vercel serverless: cờ ĐỌC LÚC BUILD (rewrites/tracing nằm trong manifest). Không đặt cờ = cấu hình cũ y nguyên.
const serverless = isServerlessRuntime();
// Bộ nạp Nest chọn lúc build: serverless = require tĩnh @trinity/monolith (Next vết vào hàm); còn lại = không require.
const turbopackConfig = {
  resolveAlias: {
    "#nest-loader": serverless ? "./src/lib/nest-loader.serverless.ts" : "./src/lib/nest-loader.ts",
  },
};

const nextConfig: NextConfig = {
  // Standalone là kiểu đóng gói cho máy chủ tự quản; Vercel tự đóng gói hàm — standalone chỉ làm phình bundle.
  ...(serverless ? {} : { output: "standalone" as const }),
  // Serverless: gốc vết (trace) = gốc monorepo `trinity/` để hàm với tới `apps/monolith/dist`, `packages/*` và node_modules pnpm.
  // Phần vết riêng của Nest (nạp bằng `require` động, Next không thấy) do `scripts/append-monolith-trace.cjs` nối vào
  // `.next/server/app/api/v1/[...path]/route.js.nft.json` SAU `next build` — KHÔNG dùng `outputFileTracingIncludes` vì hàng nghìn
  // đường dẫn làm glob Turbopack vượt giới hạn regex (`CompiledTooBig`).
  ...(serverless && {
    outputFileTracingRoot: path.join(__dirname, "../.."),
    // Nest nạp bằng `require("@trinity/monolith/serverless")` TĨNH: external ⇒ Next không đóng gói (giữ decorator metadata,
    // engine Prisma) nhưng VẪN vết đủ file + phụ thuộc pnpm vào hàm — cơ chế chính thức builder Vercel tôn trọng
    // (bản nối nft.json tay bị builder Vercel mới bỏ qua).
    serverExternalPackages: ["@trinity/monolith", "@prisma/client", ".prisma/client"],
  }),
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
  turbopack: turbopackConfig,
  // OAuth/MCP well-known. Reverse proxy chỉ chuyển `/api/v1/` → monolith, còn lại → Next, nên 2 URL khám phá nằm ở GỐC
  // (RFC 8414 §3.1 / RFC 9728 §3.1: `/.well-known/<loại>` + path của issuer/resource) phải được Next chuyển tiếp sang monolith.
  // Đích mặc định = monolith cục bộ :4000 (cùng giả định `LOCAL_ROUTES` ở app/api/v1/[...path]/route.ts).
  rewrites: async () => {
    // Serverless: Nest chạy TRONG app (không còn monolith :4000) — xem `serverlessRewrites()`.
    if (serverless) return { beforeFiles: serverlessRewrites(), afterFiles: [], fallback: [] };
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
