import type { PrismaService } from '@trinity/prisma';
import { loadFacebookConfig } from '../facebook/facebook.config';
import { decryptSecret, loadSecretKey } from '../integrations/webhooks/secret-crypto';

/** Bình luận đầu tiên — Facebook giới hạn 8.000 ký tự. */
export const FIRST_COMMENT_MAX = 8000;

export function firstCommentOf(options: Record<string, unknown>): string | null {
  return typeof options.first_comment === 'string' && options.first_comment.trim() ? options.first_comment.trim() : null;
}

/**
 * Đăng bình luận đầu tiên dưới bài vừa lên Fanpage, BẰNG TOKEN CỦA KẾT NỐI "Fanpage Facebook" (đã có quyền
 * `pages_manage_engagement` cho bình luận) — kết nối Đăng đa kênh không xin quyền này nên không phải thêm quyền mới.
 * Page chưa kết nối ở mục Fanpage Facebook ⇒ `no_page` (bỏ qua). KHÔNG log token.
 */
export async function postFirstComment(prisma: PrismaService, pageId: string, objectId: string, message: string): Promise<'posted' | 'no_page'> {
  const page = await prisma.facebookPage.findFirst({ where: { page_id: pageId, is_active: true }, select: { token_enc: true } });
  if (!page?.token_enc) return 'no_page';
  const token = decryptSecret(page.token_enc, loadSecretKey());
  const c = loadFacebookConfig();
  const res = await fetch(`https://graph.facebook.com/${c.graphVersion}/${encodeURIComponent(objectId)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ message: message.slice(0, FIRST_COMMENT_MAX), access_token: token }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Facebook từ chối bình luận đầu tiên: ${(body.error?.message ?? `HTTP ${res.status}`).slice(0, 200)}`);
  }
  return 'posted';
}
