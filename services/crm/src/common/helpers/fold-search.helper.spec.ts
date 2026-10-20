import { Prisma } from '@prisma/client';
import { foldContains, foldedIds, foldMatchSql } from './fold-search.helper';
import { recordSearchSql } from '../../custom-objects/custom-records-list.service';
import type { ObjectDef } from '../../custom-objects/custom-object-access';

describe('ô tìm dùng chung — không phân biệt hoa/thường, bỏ dấu, chuỗi con (#30)', () => {
  it('foldContains gập từ khoá: hoa/thường, dấu, đ, khoảng trắng thừa, ký tự LIKE', () => {
    expect(foldContains(' Mính ')).toBe('%minh%');
    expect(foldContains('ĐẶNG Thị')).toBe('%dang thi%');
    expect(foldContains('50%_x')).toBe('%50\\%\\_x%');
  });

  it('foldMatchSql so cột đã gập với mẫu đã gập', () => {
    const sql = foldMatchSql(Prisma.sql`title`, 'Minh');
    expect(sql.sql).toMatch(/^translate\(lower\(title\), \?, \?\) LIKE \? ESCAPE/);
    expect(sql.values[2]).toBe('%minh%');
  });

  it('foldedIds lấy id theo tên đã gập, bảng contacts bỏ dòng đã xoá', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([{ id: 7 }, { id: 3 }]);
    await expect(foldedIds({ $queryRaw } as never, 'contacts', 'minh')).resolves.toEqual([7, 3]);
    const q = $queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(q.sql).toContain('FROM contacts WHERE deleted_at IS NULL');
    expect(q.values).toContain('%minh%');
  });

  it('recordSearchSql quét tiêu đề, mã, trường chữ, nhãn lựa chọn và tên bản ghi liên kết — mọi bảng', () => {
    const def = {
      obj: {},
      fields: [
        { key: 'ghi_chu', type: 'text', options: {} },
        { key: 'sdt', type: 'phone', options: {} },
        { key: 'trang_thai', type: 'select', options: { choices: [{ value: 'dang_hoc', label: 'Đang học' }, { value: 'nghi', label: 'Nghỉ' }] } },
        { key: 'the', type: 'multi_select', options: { choices: [{ value: 'vip', label: 'Khách VIP' }] } },
        { key: 'hoc_sinh', type: 'relation', options: { target_object_id: 5 } },
        { key: 'khach', type: 'relation', options: { target: 'contact' } },
        { key: 'phu_trach', type: 'user', options: {} },
      ],
    } as unknown as ObjectDef;
    const sql = recordSearchSql(def, 'Đang');
    expect(sql.values).toEqual(expect.arrayContaining(['ghi_chu', 'dang_hoc', 'hoc_sinh', 5, 'khach', 'phu_trach', '%dang%', 'ĐANG%']));
    expect(sql.values).not.toContain('sdt');
    expect(sql.values).not.toContain('nghi');
    expect(sql.sql).toContain('FROM custom_records t WHERE t.object_id');
    expect(sql.sql).toContain('FROM contacts c');
    expect(sql.sql).toContain('FROM users u');
    expect(recordSearchSql(def, 'vip').values).toContain('vip');
  });
});
