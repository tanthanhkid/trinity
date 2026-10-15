/**
 * Màu badge "Giai đoạn" ở danh bạ: mỗi giai đoạn một cặp màu riêng để
 * "Mới", "Theo dõi 2", "Theo dõi 3" không nhìn y hệt nhau.
 *
 * Đặt ở `src/lib/` để không nằm trong cây component của trang.
 */

/** Cặp màu 1 badge. Dùng biến CSS đặt trong `html:root[data-ui="app"]`. */
export interface StageBadgeStyle {
  background: string
  color: string
}

/**
 * Khoá theo `setting_options.value` (mã BỀN) của nhóm `contact_stage`,
 * KHÔNG theo `label` — nhãn hiển thị do admin sửa được ở Cài đặt, đổi nhãn mà
 * màu biến mất là lỗi câm.
 */
const STAGE_STYLE_BY_VALUE: Record<string, StageBadgeStyle> = {
  new: {
    background: "var(--color-app-stage-new-bg)",
    color: "var(--color-app-stage-new-ink)",
  },
  follow_up_2: {
    background: "var(--color-app-stage-follow2-bg)",
    color: "var(--color-app-stage-follow2-ink)",
  },
  follow_up_3: {
    background: "var(--color-app-stage-follow3-bg)",
    color: "var(--color-app-stage-follow3-ink)",
  },
}

/** Giai đoạn ngoài 3 mã trên (kể cả tên bước tuỳ biến) giữ nguyên màu brand cũ. */
export const STAGE_BADGE_FALLBACK: StageBadgeStyle = {
  background: "var(--color-app-primary-soft)",
  color: "var(--color-app-primary-ink)",
}

/**
 * Cặp màu cho badge giai đoạn của 1 dòng danh bạ.
 *
 * `stageSource` PHẢI được xét: `contact.stage` là chuỗi ĐÃ DERIVE — khi không
 * phải giai đoạn danh bạ thì nó là tên bước khác. Tô màu theo
 * `stage.value` lúc đó là gán sai màu — sai nghĩa.
 */
export function resolveV2StageBadgeStyle(
  stageSource: string | undefined,
  stageValue: string | null | undefined,
): StageBadgeStyle {
  /**
   * `source='default'` = chưa chọn giai đoạn ⇒ BE
   * `deriveContactStage` in đúng nhãn "Mới" (hằng `DEFAULT_LABEL`) nhưng
   * `stage` là `null`. Không xử riêng thì 2 badge CÙNG chữ "Mới" ra 2
   * màu khác nhau.
   */
  if (stageSource === "default") return STAGE_STYLE_BY_VALUE.new
  if (stageSource !== "stage" || !stageValue) {
    return STAGE_BADGE_FALLBACK
  }
  return STAGE_STYLE_BY_VALUE[stageValue] ?? STAGE_BADGE_FALLBACK
}
