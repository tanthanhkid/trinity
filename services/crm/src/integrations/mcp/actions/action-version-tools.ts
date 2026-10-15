import { NotFoundException } from '@nestjs/common';
import { optInt, type Z } from '../tools/tool-types';
import { ActionUserError, type ActionToolDef } from './action-types';
import { line, lines, shown } from './action-helpers';
import { makeImpact } from './impact';

export const restoreVersionAction: ActionToolDef = {
  name: 'restore_structure_version',
  label: 'Quay lui cấu trúc',
  title: 'Quay lui cấu trúc về một phiên bản / Restore a structure version',
  description:
    'Trả cấu trúc bảng tuỳ biến (bảng, trường, màn xem, menu, module bật) về một phiên bản đã lưu (list_structure_versions) — Trinity tự lưu phiên bản TRƯỚC mỗi lần đổi cấu trúc. ' +
    'Không xoá dữ liệu bản ghi: bảng/trường tạo sau phiên bản bị ẨN, trường đã ẩn được hiện lại. Chạy ngay — hỏi người dùng xác nhận trước. CHỈ quản trị viên. / ' +
    'Rolls the custom structure back to a saved version immediately (record data is kept). Admins only.',
  permissions: ['custom_objects.manage', 'settings.features'],
  destructive: true,
  idempotent: true,
  input: (z: Z) => ({ version_id: z.number().int().min(1).max(2_147_483_647).describe('id phiên bản từ list_structure_versions / Version id') }),
  async prepare(args, { deps }) {
    const id = optInt(args.version_id);
    if (!id) throw new ActionUserError('version_id phải là số nguyên dương (lấy từ list_structure_versions).');
    const snap = await deps.versions.load(id).catch((e: unknown) => {
      if (e instanceof NotFoundException) throw new ActionUserError(`Không có phiên bản cấu trúc #${id}. Gọi list_structure_versions.`);
      throw e;
    });
    const diff = await deps.versions.diff(snap);
    if (diff.tables.length === 0) throw new ActionUserError(`Cấu trúc hiện tại đã giống phiên bản #${id} — không có gì để quay lui.`);
    return {
      params: { version_id: id },
      summary: shown(`Quay lui cấu trúc về phiên bản #${id}: ${diff.tables.map((t) => t.label).join(', ')}`),
      details: lines(...diff.tables.map((t) => line(`${t.label} [${t.key}]`, `${t.change} — ${t.records} bản ghi`))),
      impact: makeImpact(diff.tables.map(({ key, label, records }) => ({ key, label, records })), diff.tables.map((t) => `${t.label}: ${t.change} (${t.records} bản ghi)`)),
    };
  },
  execute: (params, { deps, user }) => deps.versions.restore(Number(params.version_id), user.userId),
};
