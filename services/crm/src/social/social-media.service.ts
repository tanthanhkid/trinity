import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { SocialMediaAsset } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { extname } from 'node:path';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { AuthUser } from '@trinity/rbac-nest';
import { SafeGetError, safeGetMedia } from '../integrations/common/safe-http-get';
import { StorageService } from '../storage/storage.service';
import type { LoadedMedia, SocialMedia } from './providers/provider.types';
import { IMAGE_EXT_CONTENT_TYPE, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, VIDEO_EXT_CONTENT_TYPE } from './social.config';

const KEY_RE = /^social\/u(\d+)_\d+_[a-z0-9]+(\.[a-z0-9]+)$/;

function kindOf(fileName: string): { ext: string; type: 'image' | 'video'; content_type: string; max: number } {
  const ext = extname(fileName).toLowerCase();
  if (IMAGE_EXT_CONTENT_TYPE[ext]) return { ext, type: 'image', content_type: IMAGE_EXT_CONTENT_TYPE[ext], max: MAX_IMAGE_BYTES };
  if (VIDEO_EXT_CONTENT_TYPE[ext]) return { ext, type: 'video', content_type: VIDEO_EXT_CONTENT_TYPE[ext], max: MAX_VIDEO_BYTES };
  throw new BadRequestException('Chỉ nhận ảnh JPG/PNG/WebP/GIF hoặc video MP4/MOV/WebM.');
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** Tải từ link (AI đưa tệp nó vừa tạo): video trần thấp hơn tải trực tiếp vì cả tệp nằm trong RAM của hàm. */
export const MAX_IMPORT_VIDEO_BYTES = 100 * 1024 * 1024;
/** base64 đi trong thân request MCP (Vercel ≤ 4,5 MB) ⇒ chỉ hợp ảnh nhỏ. */
export const MAX_BASE64_BYTES = 3 * 1024 * 1024;

const CONTENT_TYPE_EXT: Record<string, string> = Object.fromEntries(
  [...Object.entries(IMAGE_EXT_CONTENT_TYPE), ...Object.entries(VIDEO_EXT_CONTENT_TYPE)].filter(([e]) => e !== '.jpeg').map(([e, t]) => [t, e]),
);

const IMPORT_ERRORS: Record<string, string> = {
  blocked_target: 'Link phải là https công khai (không nhận địa chỉ nội bộ).',
  redirect_not_followed: 'Link chuyển hướng sang chỗ khác — đưa link trực tiếp tới tệp.',
  not_media: 'Link không trả về ảnh hay video.',
  too_large: 'Tệp quá lớn.',
  timeout: 'Tải tệp quá lâu (quá 30 giây).',
  network_error: 'Không tải được tệp từ link này.',
};

/** Tên hiển thị trong thư viện: bỏ đường dẫn, gọn ≤ 200 ký tự. */
export function displayName(raw: string | undefined | null, fallback: string): string {
  const n = (raw ?? '').split(/[\\/]/).pop()?.replace(/[\u0000-\u001f]/g, '').trim();
  return (n || fallback).slice(0, 200);
}

/** Đuôi tệp theo content-type (ưu tiên), không thì theo tên/đường dẫn. */
export function extFor(contentType: string, nameOrPath?: string | null): string | null {
  const byType = CONTENT_TYPE_EXT[contentType.toLowerCase()];
  if (byType) return byType;
  const e = extname((nameOrPath ?? '').split(/[?#]/)[0]).toLowerCase();
  return IMAGE_EXT_CONTENT_TYPE[e] || VIDEO_EXT_CONTENT_TYPE[e] ? e : null;
}

const LIBRARY_SELECT = { id: true, key: true, type: true, content_type: true, size: true, name: true, source: true, uploaded_by: true, created_at: true } as const;

export type LibraryItem = Pick<SocialMediaAsset, 'id' | 'key' | 'type' | 'content_type' | 'size' | 'name' | 'source' | 'uploaded_by' | 'created_at'>;

/**
 * Tệp đính kèm bài đăng — nằm trong StorageService (Vercel Blob / đĩa VPS), khoá `social/u<userId>_<ts>_<rand><ext>`
 * mang id người tải để chỉ chính người đó gắn được vào bài.
 */
@Injectable()
export class SocialMediaService {
  constructor(
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  private newKey(user: AuthUser, ext: string): string {
    return `social/u${user.userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  }

  /** Vercel: trình duyệt PUT thẳng lên Blob (body hàm ≤ 4,5 MB). Môi trường khác ⇒ 400, FE gửi multipart. */
  uploadToken(user: AuthUser, fileName: string, size: number) {
    if (!this.storage.isClientUploadSupported()) throw new BadRequestException('Môi trường này không dùng upload trực tiếp — gửi tệp qua POST /social/media');
    const k = kindOf(fileName);
    if (size > k.max) throw new BadRequestException(`Tệp quá lớn (tối đa ${mb(k.max)}).`);
    const key = this.newKey(user, k.ext);
    return { key, type: k.type, content_type: k.content_type, max_bytes: k.max, ...this.storage.createClientUpload(key, k.content_type, k.max) };
  }

  /** Multipart qua BE (VPS, hoặc tệp nhỏ trên Vercel). Tệp tạm của multer luôn bị xoá. */
  async uploadFile(user: AuthUser, file: { originalname: string; path: string; size: number } | undefined): Promise<SocialMedia> {
    if (!file) throw new BadRequestException('Thiếu tệp');
    try {
      const k = kindOf(file.originalname);
      if (file.size > k.max) throw new BadRequestException(`Tệp quá lớn (tối đa ${mb(k.max)}).`);
      const key = this.newKey(user, k.ext);
      await this.storage.upload(key, createReadStream(file.path), k.content_type, file.size);
      const m: SocialMedia = { key, type: k.type, content_type: k.content_type, size: file.size };
      await this.record(user, m, displayName(file.originalname, key), 'web');
      return m;
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }

  /**
   * Khoá do AI/FE gửi lên ⇒ mô tả tệp đã kiểm: đúng dạng, có thật trong kho, và của chính người dùng HOẶC đang có trong
   * thư viện chung (người khác trong công ty tải lên, chưa ẩn).
   */
  async resolve(user: AuthUser, keys: string[]): Promise<SocialMedia[]> {
    const out: SocialMedia[] = [];
    const shared = new Set(
      (await this.prisma.socialMediaAsset.findMany({ where: { key: { in: keys }, hidden_at: null }, select: { key: true } })).map((a) => a.key),
    );
    for (const key of keys) {
      const m = KEY_RE.exec(key);
      if (!m || (Number(m[1]) !== user.userId && !shared.has(key))) throw new BadRequestException(`Tệp không hợp lệ: ${key.slice(0, 80)}`);
      const k = kindOf(key);
      let size = 0;
      try {
        const probe = await this.storage.getObjectStreamRange(key, 'bytes=0-0');
        probe.body.destroy();
        size = Number(/\/(\d+)$/.exec(probe.contentRange ?? '')?.[1] ?? probe.contentLength ?? 0);
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchKey') throw new BadRequestException('Tệp chưa được tải lên hoặc đã hết hạn');
        throw err;
      }
      if (size > k.max) throw new BadRequestException(`Tệp quá lớn (tối đa ${mb(k.max)}).`);
      out.push({ key, type: k.type, content_type: k.content_type, size });
    }
    return out;
  }

  /** Ghi tệp vào thư viện (đã có khoá thì giữ nguyên dòng cũ). */
  async record(user: AuthUser, m: SocialMedia, name: string, source: 'web' | 'mcp'): Promise<LibraryItem> {
    return this.prisma.socialMediaAsset.upsert({
      where: { key: m.key },
      create: { key: m.key, type: m.type, content_type: m.content_type, size: m.size, name, source, uploaded_by: user.userId },
      update: {},
      select: LIBRARY_SELECT,
    });
  }

  /** Sau khi trình duyệt PUT thẳng lên Blob: kiểm khoá (của chính người dùng, có thật) rồi đưa vào thư viện. */
  async register(user: AuthUser, key: string, name?: string): Promise<LibraryItem> {
    const [m] = await this.resolve(user, [key]);
    return this.record(user, m, displayName(name, key), 'web');
  }

  /** Thư viện chung, mới nhất trước; lọc loại / tên. */
  async list(q: { type?: string; q?: string; limit?: number; cursor?: number }): Promise<{ data: LibraryItem[]; next_cursor: number | null }> {
    const limit = Math.min(Math.max(q.limit ?? 24, 1), 100);
    const rows = await this.prisma.socialMediaAsset.findMany({
      where: {
        hidden_at: null,
        ...(q.type === 'image' || q.type === 'video' ? { type: q.type } : {}),
        ...(q.q?.trim() ? { name: { contains: q.q.trim().slice(0, 100), mode: 'insensitive' as const } } : {}),
        ...(q.cursor ? { id: { lt: q.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: LIBRARY_SELECT,
    });
    return { data: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1].id : null };
  }

  private async asset(id: number): Promise<SocialMediaAsset> {
    const a = await this.prisma.socialMediaAsset.findUnique({ where: { id } });
    if (!a || a.hidden_at) throw new NotFoundException('Không tìm thấy tệp trong thư viện');
    return a;
  }

  /** Xem trước tệp trong thư viện (BE stream — đĩa VPS và Blob đều chạy). */
  async open(id: number) {
    const a = await this.asset(id);
    const obj = await this.storage.getObjectStream(a.key);
    return { body: obj.body, contentType: a.content_type, contentLength: a.size, name: a.name };
  }

  /** Mở tệp theo key (link có chữ ký cho mạng tải về). */
  async openKey(key: string) {
    const obj = await this.storage.getObjectStream(key);
    return { body: obj.body, contentLength: obj.contentLength ?? null };
  }

  /** Ẩn khỏi thư viện — KHÔNG xoá tệp (bài đã đăng / đã hẹn vẫn dùng). */
  async hide(id: number): Promise<{ id: number; hidden: true }> {
    await this.asset(id);
    await this.prisma.socialMediaAsset.update({ where: { id }, data: { hidden_at: new Date() } });
    return { id, hidden: true };
  }

  /** AI đưa link ảnh/video công khai (vd tệp nó vừa tạo) ⇒ tải về kho của Trinity, vào thư viện. */
  async importFromUrl(user: AuthUser, url: string, name?: string): Promise<LibraryItem> {
    let got: { contentType: string; body: Buffer };
    try {
      got = await safeGetMedia(url, { maxBytes: Math.max(MAX_IMAGE_BYTES, MAX_IMPORT_VIDEO_BYTES) });
    } catch (err) {
      if (err instanceof SafeGetError) throw new BadRequestException(IMPORT_ERRORS[err.message] ?? `Không tải được tệp (${err.message}).`);
      throw err;
    }
    const ext = extFor(got.contentType, url);
    if (!ext) throw new BadRequestException('Chỉ nhận ảnh JPG/PNG/WebP/GIF hoặc video MP4/MOV/WebM.');
    let fromPath = '';
    try {
      fromPath = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    } catch {
      /* tên trong link hỏng ⇒ dùng tên mặc định */
    }
    return this.store(user, got.body, ext, displayName(name, fromPath || 'tep-tu-link'), 'mcp');
  }

  /** Ảnh nhỏ gửi thẳng dạng base64 (≤ 3 MB) ⇒ vào thư viện. */
  async importBase64(user: AuthUser, data: string, fileName: string, name?: string): Promise<LibraryItem> {
    const raw = data.replace(/^data:[^;,]+;base64,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new BadRequestException('data_base64 không phải base64 hợp lệ.');
    if ((raw.length * 3) / 4 > MAX_BASE64_BYTES + 4) throw new BadRequestException(`Gửi base64 tối đa ${mb(MAX_BASE64_BYTES)} — tệp lớn hơn thì đưa link (url).`);
    const ext = extFor('', fileName);
    if (!ext) throw new BadRequestException('file_name phải có đuôi .jpg/.png/.webp/.gif/.mp4/.mov/.webm.');
    return this.store(user, Buffer.from(raw, 'base64'), ext, displayName(name ?? fileName, fileName), 'mcp');
  }

  private async store(user: AuthUser, body: Buffer, ext: string, name: string, source: 'web' | 'mcp'): Promise<LibraryItem> {
    const k = kindOf(`x${ext}`);
    if (!body.length) throw new BadRequestException('Tệp rỗng.');
    const max = k.type === 'video' ? Math.min(k.max, MAX_IMPORT_VIDEO_BYTES) : k.max;
    if (body.length > max) throw new BadRequestException(`Tệp quá lớn (tối đa ${mb(max)}).`);
    const key = this.newKey(user, k.ext);
    await this.storage.upload(key, body, k.content_type, body.length);
    return this.record(user, { key, type: k.type, content_type: k.content_type, size: body.length }, name, source);
  }

  /** Nạp nội dung tệp vào RAM để gửi lên mạng (trần theo loại). */
  async load(m: SocialMedia): Promise<LoadedMedia> {
    const max = m.type === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    const obj = await this.storage.getObjectStream(m.key);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of obj.body) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
      total += b.length;
      if (total > max) {
        obj.body.destroy();
        throw new BadRequestException(`Tệp quá lớn (tối đa ${mb(max)}).`);
      }
      chunks.push(b);
    }
    return { ...m, body: Buffer.concat(chunks) };
  }
}
