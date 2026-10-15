import { BadRequestException } from '@nestjs/common';
import { normalizePrefix, prefixTaken, suggestPrefix } from '../../../custom-objects/record-codes';
import { ActionUserError, type ActionDeps } from './action-types';
import type { ObjectSpec } from './structure-spec';

/** Tiền tố AI ghi (nếu có) → chuẩn hoá; sai ⇒ lỗi AI sửa được. */
export function readPrefix(raw: unknown, label: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  try {
    return normalizePrefix(String(raw));
  } catch (e) {
    if (e instanceof BadRequestException) throw new ActionUserError(`Bảng “${label}”: ${e.message}`);
    throw e;
  }
}

/**
 * Chốt tiền tố mã cho các bảng SẮP tạo ngay lúc đề xuất (người duyệt thấy trước "Bệnh nhân → BN001"), duy nhất trong gói lẫn
 * với hệ thống: AI đặt thì kiểm, không đặt thì lấy gợi ý của DB (cùng thuật toán trigger) rồi nối A–Z nếu trùng trong gói.
 */
export async function assignPrefixes(deps: ActionDeps, specs: ObjectSpec[]): Promise<void> {
  const used = new Set<string>();
  for (const s of specs) {
    if (s.code_prefix) {
      if (used.has(s.code_prefix) || (await prefixTaken(deps.prisma, s.code_prefix, null))) throw new ActionUserError(`Tiền tố mã “${s.code_prefix}” (bảng “${s.label}”) đã được dùng — chọn tiền tố khác hoặc bỏ trống để tự sinh.`);
      used.add(s.code_prefix);
      continue;
    }
    const base = await suggestPrefix(deps.prisma, s.label);
    let pick = base;
    for (let i = 0; used.has(pick) || (pick !== base && (await prefixTaken(deps.prisma, pick, null))); i++) {
      if (i >= 26) throw new ActionUserError(`Không tự sinh được tiền tố mã cho bảng “${s.label}” — hãy đặt code_prefix.`);
      pick = `${base.slice(0, 3)}${String.fromCharCode(65 + i)}`;
    }
    used.add(pick);
    s.code_prefix = pick;
  }
}
