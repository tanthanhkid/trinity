/**
 * Logo chính thức của các hãng Trinity kết nối (nguồn: `public/brand/logos/SOURCES.md`). Dùng ở thẻ kết nối và Tổng quan
 * thay cho ô chữ viết tắt. Logo vẽ trên nền trắng ở cả chế độ tối (logo hãng thiết kế cho nền sáng).
 */
export const BRAND_LOGOS = {
  chatgpt: '/brand/ai/chatgpt.svg',
  claude: '/brand/ai/claude.svg',
  gemini: '/brand/ai/gemini.svg',
  facebook: '/brand/logos/facebook.svg',
  messenger: '/brand/logos/messenger.svg',
  youtube: '/brand/logos/youtube.svg',
  zalo: '/brand/logos/zalo.svg',
  instagram: '/brand/logos/instagram.svg',
  tiktok: '/brand/logos/tiktok.svg',
  sepay: '/brand/logos/sepay.png',
  vnpay: '/brand/logos/vnpay.png',
  momo: '/brand/logos/momo.png',
  kiotviet: '/brand/logos/kiotviet.png',
  sapo: '/brand/logos/sapo.png',
  woocommerce: '/brand/logos/woocommerce.svg',
  shopee: '/brand/logos/shopee.svg',
  lazada: '/brand/logos/lazada.png',
  misa: '/brand/logos/misa.jpg',
  ipos: '/brand/logos/ipos.png',
  google_sheets: '/brand/logos/google-sheets.svg',
  google_business: '/brand/logos/google-business.svg',
  n8n: '/brand/logos/n8n.svg',
  zapier: '/brand/logos/zapier.svg',
  make: '/brand/logos/make.svg',
} as const

export type BrandKey = keyof typeof BRAND_LOGOS

export function isBrandKey(x: string | null | undefined): x is BrandKey {
  return !!x && Object.prototype.hasOwnProperty.call(BRAND_LOGOS, x)
}
