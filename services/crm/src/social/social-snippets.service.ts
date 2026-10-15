import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import type { SocialSnippet } from '@prisma/client';

export const SNIPPET_KINDS = ['hashtags', 'signature'] as const;
export type SnippetKind = (typeof SNIPPET_KINDS)[number];
export const MAX_SNIPPETS = 100;
const MAX_NAME = 80;
const MAX_CONTENT = 2000;
const MAX_TAG = 100;

export interface SnippetInput {
  kind?: string;
  name?: string;
  content?: string;
  is_default?: boolean;
}

const bad = (m: string) => new BadRequestException(m);
/** Khoá advisory: đếm giới hạn + "một chữ ký mặc định" đúng cả khi lưu đồng thời. */
const SNIPPETS_LOCK = 7_524_001;

/** Bộ hashtag: tách theo khoảng trắng/dấu phẩy, thêm # còn thiếu, bỏ trùng không phân biệt hoa thường, nối bằng một dấu cách. */
export function normalizeHashtags(raw: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.normalize('NFC').split(/[\s,]+/)) {
    if (!part) continue;
    const tag = part.startsWith('#') ? part : `#${part}`;
    if (tag === '#') continue;
    if (tag.length > MAX_TAG) throw bad(`Hashtag quá dài (tối đa ${MAX_TAG} ký tự).`);
    if (tag.indexOf('#', 1) !== -1) throw bad(`Hashtag "${tag.slice(0, 30)}" chứa nhiều dấu #; tách bằng dấu cách.`);
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.join(' ');
}

function checkName(v: unknown): string {
  if (typeof v !== 'string') throw bad('Cần tên mẫu.');
  const n = v.trim();
  if (n.length < 1 || n.length > MAX_NAME) throw bad(`Tên mẫu từ 1 đến ${MAX_NAME} ký tự.`);
  return n;
}

function checkContent(kind: string, v: unknown): string {
  if (typeof v !== 'string') throw bad('Cần nội dung mẫu.');
  const c = kind === 'hashtags' ? normalizeHashtags(v) : v.trim();
  if (c.length < 1 || c.length > MAX_CONTENT) throw bad(`Nội dung mẫu từ 1 đến ${MAX_CONTENT} ký tự.`);
  return c;
}

function checkKind(v: unknown): SnippetKind {
  if (!SNIPPET_KINDS.includes(v as SnippetKind)) throw bad('Loại mẫu phải là hashtags hoặc signature.');
  return v as SnippetKind;
}

/** Bộ hashtag và chữ ký dùng lại khi soạn bài. */
@Injectable()
export class SocialSnippetsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(kind?: string): Promise<SocialSnippet[]> {
    if (kind !== undefined && kind !== '') checkKind(kind);
    return this.prisma.socialSnippet.findMany({
      where: kind ? { kind } : undefined,
      orderBy: [{ kind: 'asc' }, { position: 'asc' }, { id: 'asc' }],
    });
  }

  async create(user: AuthUser, input: SnippetInput): Promise<SocialSnippet> {
    const kind = checkKind(input.kind);
    const name = checkName(input.name);
    const content = checkContent(kind, input.content);
    if (input.is_default !== undefined && typeof input.is_default !== 'boolean') throw bad('is_default phải là true/false.');
    if (input.is_default && kind !== 'signature') throw bad('Chỉ chữ ký mới đặt được mặc định.');
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SNIPPETS_LOCK})`;
      if ((await tx.socialSnippet.count()) >= MAX_SNIPPETS) throw bad(`Tối đa ${MAX_SNIPPETS} mẫu.`);
      if (input.is_default) await tx.socialSnippet.updateMany({ where: { kind, is_default: true }, data: { is_default: false } });
      const last = await tx.socialSnippet.aggregate({ where: { kind }, _max: { position: true } });
      return tx.socialSnippet.create({
        data: { kind, name, content, is_default: input.is_default === true, position: (last._max.position ?? -1) + 1, created_by: user.userId },
      });
    });
  }

  /** Chỉ trường có gửi; không đổi `kind` sau khi tạo. */
  async update(id: number, input: SnippetInput): Promise<SocialSnippet> {
    const cur = await this.prisma.socialSnippet.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Không tìm thấy mẫu');
    if (input.kind !== undefined && input.kind !== cur.kind) throw bad('Không đổi loại của mẫu đã tạo.');
    const data: { name?: string; content?: string; is_default?: boolean } = {};
    if (input.name !== undefined) data.name = checkName(input.name);
    if (input.content !== undefined) data.content = checkContent(cur.kind, input.content);
    if (input.is_default !== undefined) {
      if (typeof input.is_default !== 'boolean') throw bad('is_default phải là true/false.');
      if (input.is_default && cur.kind !== 'signature') throw bad('Chỉ chữ ký mới đặt được mặc định.');
      data.is_default = input.is_default;
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SNIPPETS_LOCK})`;
      if (data.is_default) await tx.socialSnippet.updateMany({ where: { kind: cur.kind, is_default: true, id: { not: id } }, data: { is_default: false } });
      return tx.socialSnippet.update({ where: { id }, data });
    });
  }

  async remove(id: number): Promise<void> {
    const r = await this.prisma.socialSnippet.deleteMany({ where: { id } });
    if (r.count === 0) throw new NotFoundException('Không tìm thấy mẫu');
  }
}
