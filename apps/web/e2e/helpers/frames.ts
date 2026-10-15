/**
 * 3 KHUNG của project `design`: điện thoại 390×844 (cảm ứng), iPad 768×1024 (cảm ứng),
 * máy tính 1440×900. Khai ở 1 chỗ — `playwright.config.ts` dựng project `design-<khung>`,
 * spec đọc khung hiện hành bằng `currentFrame(testInfo)`.
 */
export type FrameKey = 'mobile' | 'tablet' | 'desktop'

export interface Frame {
  key: FrameKey
  label: string
  viewport: { width: number; height: number }
  touch: boolean
}

export const FRAMES: Record<FrameKey, Frame> = {
  mobile: { key: 'mobile', label: 'điện thoại 390×844', viewport: { width: 390, height: 844 }, touch: true },
  tablet: { key: 'tablet', label: 'iPad 768×1024', viewport: { width: 768, height: 1024 }, touch: true },
  desktop: { key: 'desktop', label: 'máy tính 1440×900', viewport: { width: 1440, height: 900 }, touch: false },
}

export function currentFrame(testInfo: { project: { metadata: Record<string, unknown> } }): Frame {
  return FRAMES[(testInfo.project.metadata.frame as FrameKey) ?? 'desktop']
}
