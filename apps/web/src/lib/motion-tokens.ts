/**
 * Motion token dùng chung — "calm motion" theo Arc Library của Elia Kuratli
 * (https://github.com/kuratlielia/arc-library, MIT License, Copyright (c) 2026 Elia Kuratli).
 * Giữ đúng giá trị gốc để các component phỏng theo Arc chuyển động cùng một nhịp.
 */
export const motionTokens = {
  duration: { instant: 0.12, fast: 0.16, exit: 0.18, standard: 0.24, considered: 0.48 },
  ease: {
    enter: [0.16, 1, 0.3, 1],
    exit: [0.7, 0, 0.84, 0],
    standard: [0.22, 1, 0.36, 1],
    /** Phần tử đang trên màn hình đổi chỗ. */
    inOut: [0.65, 0, 0.35, 1],
  },
  spring: {
    responsive: { type: "spring", stiffness: 520, damping: 38 },
    gentle: { type: "spring", stiffness: 340, damping: 34 },
    /** Bấm, bật tắt, chỉ báo nhỏ — dừng nhanh, nảy nhẹ. */
    snappy: { type: "spring", visualDuration: 0.26, bounce: 0.12 },
    /** Panel, đổi chiều cao, đổi bố cục — không vượt đích. */
    smooth: { type: "spring", visualDuration: 0.4, bounce: 0 },
  },
} as const

/** Đường cong CSS tương ứng `ease.enter` — cho chỗ không dùng Motion (vd drop animation của dnd-kit). */
export const CSS_EASE_ENTER = "cubic-bezier(0.16, 1, 0.3, 1)"
