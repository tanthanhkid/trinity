import { publicBaseUrl } from '../integrations/oauth/oauth-config';

/**
 * Đăng đa kênh: soạn 1 lần → đăng ngay hoặc hẹn giờ (tối đa 90 ngày) ra nhiều kênh. Mỗi mạng một provider (`providers/*`).
 * Facebook Page, Instagram, YouTube, TikTok, Google Business Profile (bài cập nhật + đánh giá). Bỏ X (Thanh 14/10/2026: API trả phí).
 */
export const SOCIAL_NETWORKS = ['facebook', 'instagram', 'youtube', 'tiktok', 'google_business'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export const isSocialNetwork = (v: unknown): v is SocialNetwork => typeof v === 'string' && (SOCIAL_NETWORKS as readonly string[]).includes(v);

export const NETWORK_LABELS: Record<SocialNetwork, string> = {
  facebook: 'Facebook Page',
  instagram: 'Instagram',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  google_business: 'Google Business Profile',
};

/** Giới hạn ký tự nội dung theo mạng (FE đếm, BE chặn). */
export const CAPTION_LIMITS: Record<SocialNetwork, number> = {
  facebook: 63_206,
  instagram: 2_200,
  youtube: 5_000,
  tiktok: 2_200,
  google_business: 1_500,
};

/**
 * Điểm mạng "gập" nội dung sau "Xem thêm" — số XẤP XỈ (mỗi mạng đổi theo thiết bị/giao diện, không có API chính thức),
 * chỉ dùng cho bản xem trước. `chars` = số ký tự hiện trước, `lines` = số dòng hiện trước (nếu có); chạm mốc nào trước thì gập ở đó.
 * YouTube tính trên MÔ TẢ video.
 */
export const SEE_MORE_AT: Record<SocialNetwork, { chars: number; lines?: number }> = {
  facebook: { chars: 480, lines: 5 },
  instagram: { chars: 125 },
  tiktok: { chars: 150 },
  youtube: { chars: 160 },
  google_business: { chars: 1_500 },
};

/** Vị trí (số ký tự) mạng bắt đầu giấu chữ sau "Xem thêm"; chữ ngắn hơn mốc ⇒ null (hiện đủ). */
export function truncatedAt(network: SocialNetwork, text: string): number | null {
  const r = SEE_MORE_AT[network];
  let cut = text.length > r.chars ? r.chars : -1;
  if (r.lines) {
    let idx = -1;
    for (let i = 0; i < r.lines && (idx = text.indexOf('\n', idx + 1)) >= 0; i++);
    // Hết dòng thứ `lines` mà còn chữ phía sau ⇒ gập tại đó.
    if (idx >= 0 && text.slice(idx + 1).trim() && (cut < 0 || idx < cut)) cut = idx;
  }
  return cut < 0 ? null : cut;
}

/** Trần một tệp đính kèm. Vercel: tệp > 4,5 MB phải tải thẳng lên Blob (upload-token). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const MAX_MEDIA_PER_POST = 10;

export const IMAGE_EXT_CONTENT_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
export const VIDEO_EXT_CONTENT_TYPE: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** URL Meta/Google/TikTok chuyển người dùng về sau khi đồng ý. Phải đăng ký ĐÚNG chuỗi này trong app của từng mạng. */
export const socialRedirectUri = (base: string, network: SocialNetwork): string => `${base}/api/v1/social/oauth/callback/${network}`;

export function socialBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return publicBaseUrl(env);
}

/** Hẹn giờ đăng tối đa bao xa (dùng chung service và tool AI). */
export const MAX_SCHEDULE_AHEAD_MS = 90 * 86_400_000;
