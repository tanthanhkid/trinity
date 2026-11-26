import { publicBaseUrl } from '../integrations/oauth/oauth-config';

/**
 * Đăng bài: soạn 1 lần → đăng ngay hoặc hẹn giờ (tối đa 90 ngày) ra một hoặc nhiều Fanpage. Mỗi mạng một provider (`providers/*`);
 * hiện chỉ còn Facebook Page. YouTube, TikTok, Google Business Profile, Instagram đã gỡ (G04) — dữ liệu cũ của chúng giữ làm lịch sử.
 */
export const SOCIAL_NETWORKS = ['facebook'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export const isSocialNetwork = (v: unknown): v is SocialNetwork => typeof v === 'string' && (SOCIAL_NETWORKS as readonly string[]).includes(v);

export const NETWORK_LABELS: Record<SocialNetwork, string> = {
  facebook: 'Facebook Page',
};

/**
 * Mạng đã gỡ khỏi Trinity (migration `0021_social_fanpage_only`): kênh cũ ở trạng thái `disabled`, bài cũ giữ làm lịch sử.
 * Chỉ dùng để hiện tên và báo lỗi rõ ràng khi có ai gọi tới — không còn mã đăng/kết nối nào.
 */
export const REMOVED_SOCIAL_NETWORKS: Record<string, string> = {
  instagram: 'Instagram',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  google_business: 'Google Business Profile',
};

/** Câu báo khi thao tác trên mạng đã gỡ; null nếu `network` không phải mạng đã gỡ. */
export function removedNetworkMessage(network: unknown): string | null {
  if (typeof network !== 'string' || !Object.hasOwn(REMOVED_SOCIAL_NETWORKS, network)) return null;
  return `Trinity đã ngừng hỗ trợ ${REMOVED_SOCIAL_NETWORKS[network]}: chỉ còn đăng bài lên Fanpage Facebook. Bài cũ vẫn xem được trong lịch sử.`;
}

/** Tên hiển thị của mạng, kể cả mạng đã gỡ (bài cũ). */
export const networkLabel = (network: string): string => (isSocialNetwork(network) ? NETWORK_LABELS[network] : (REMOVED_SOCIAL_NETWORKS[network] ?? network));

/** Giới hạn ký tự nội dung theo mạng (FE đếm, BE chặn). */
export const CAPTION_LIMITS: Record<SocialNetwork, number> = {
  facebook: 63_206,
};

/**
 * Điểm mạng "gập" nội dung sau "Xem thêm" — số XẤP XỈ (đổi theo thiết bị/giao diện, không có API chính thức),
 * chỉ dùng cho bản xem trước. `chars` = số ký tự hiện trước, `lines` = số dòng hiện trước (nếu có); chạm mốc nào trước thì gập ở đó.
 */
export const SEE_MORE_AT: Record<SocialNetwork, { chars: number; lines?: number }> = {
  facebook: { chars: 480, lines: 5 },
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

/** Trần một tệp đính kèm. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Trần video mặc định (MB). Bản cài sau proxy Cloudflare (body ≤ 100 MB) đặt `SOCIAL_MAX_VIDEO_MB=95`. */
export const DEFAULT_MAX_VIDEO_MB = 200;
/**
 * Trần cứng của video ĐÃ có trong kho (nạp để đăng bài hẹn giờ, dùng lại từ thư viện): luôn 200 MB, KHÔNG theo env —
 * hạ `SOCIAL_MAX_VIDEO_MB` không được làm hỏng bài đã hẹn hay video cũ trong thư viện.
 */
export const MAX_STORED_VIDEO_BYTES = DEFAULT_MAX_VIDEO_MB * 1024 * 1024;

/**
 * Trần video MỚI tải lên / nhập từ link / xin upload-token (byte) theo `SOCIAL_MAX_VIDEO_MB` (số MB nguyên, 1–200; trống
 * hoặc sai ⇒ 200). Đọc env mỗi lần gọi (không chốt lúc nạp module, khi `.env` có thể chưa nạp).
 */
export function maxVideoBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.SOCIAL_MAX_VIDEO_MB ?? '').trim();
  const mb = /^\d+$/.test(raw) ? Number(raw) : 0;
  return (mb >= 1 ? Math.min(mb, DEFAULT_MAX_VIDEO_MB) : DEFAULT_MAX_VIDEO_MB) * 1024 * 1024;
}
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

/** URL Meta chuyển người dùng về sau khi đồng ý. Phải đăng ký ĐÚNG chuỗi này trong app Meta. */
export const socialRedirectUri = (base: string, network: SocialNetwork): string => `${base}/api/v1/social/oauth/callback/${network}`;

export function socialBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return publicBaseUrl(env);
}

/** Hẹn giờ đăng tối đa bao xa (dùng chung service và tool AI). */
export const MAX_SCHEDULE_AHEAD_MS = 90 * 86_400_000;
