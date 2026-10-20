import { getReportTool } from '../tools/report-tools';
import { ToolUserError } from '../tools/tool-types';

const ctx = (d: any) => ({ deps: d, baseUrl: 'https://crm.example', principal: { userId: 7, user: { userId: 7 } } }) as never;

describe('get_report (#25)', () => {
  const customReports = {
    list: jest.fn(async () => ({ reports: [{ id: 'thu_tien', name: 'Thu tiền', source_label: 'Thanh toán', source: 'x:thanh_toan' }], can_manage: true })),
    run: jest.fn(async () => ({
      report: { id: 'thu_tien', name: 'Thu tiền' }, period: { value: 'month:2026-09', label: 'Tháng 9/2026' }, count: 2, sums: { so_tien: 2_000_000 },
      missing_date: 0, groups: [{ key: 'ck', label: 'Chuyển khoản', count: 1, sums: { so_tien: 1_500_000 } }],
      by_month: [{ month: '2026-09', count: 2, sums: {} }],
      fields: { date: 'Ngày thanh toán', sums: [{ key: 'so_tien', label: 'Số tiền' }], group: 'Phương thức' },
    })),
  };

  it('không có report_id ⇒ danh sách báo cáo người dùng mở được (không lộ can_manage / nguồn kỹ thuật)', async () => {
    const r = (await getReportTool.run({}, ctx({ customReports }))).structured as any;
    expect(r.data).toEqual({ reports: [{ id: 'thu_tien', name: 'Thu tiền', table: 'Thanh toán' }] });
    expect(customReports.list).toHaveBeenCalledWith({ userId: 7 });
  });

  it('có report_id ⇒ chạy theo kỳ, cùng service + người dùng của web', async () => {
    const r = (await getReportTool.run({ report_id: 'thu_tien', period: 'month:2026-09' }, ctx({ customReports }))).structured as any;
    expect(customReports.run).toHaveBeenCalledWith({ userId: 7 }, 'thu_tien', 'month:2026-09');
    expect(r.data).toMatchObject({
      period: 'Tháng 9/2026', count: 2, sums: [{ label: 'Số tiền', total: 2_000_000 }],
      groups: { by: 'Phương thức', rows: [{ label: 'Chuyển khoản', count: 1, sums: [1_500_000] }] },
    });
    expect(r.notice).toBeDefined();
  });

  it('chỉ đọc, không đòi quyền riêng (máy chủ tự lọc theo bảng); thiếu service ⇒ lỗi rõ ràng', async () => {
    expect(getReportTool.permissions).toEqual([]);
    expect(getReportTool.scope).toBeUndefined();
    await expect(getReportTool.run({}, ctx({}))).rejects.toBeInstanceOf(ToolUserError);
  });
});
