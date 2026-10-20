import { normalizeReportDefs, parseReportPeriod } from '../report-def';

describe('báo cáo dùng chung (#25) — kỳ và định nghĩa', () => {
  const now = new Date('2026-12-31T18:30:00Z'); // 01/01/2027 giờ VN

  it('kỳ: Tháng này theo giờ VN, tháng/năm cụ thể, Tất cả; sai dạng ⇒ Tháng này', () => {
    expect(parseReportPeriod(undefined, now)).toEqual({ kind: 'range', from: '2027-01-01', to: '2027-02-01', label: 'Tháng 1/2027' });
    expect(parseReportPeriod('month:2026-12', now)).toMatchObject({ from: '2026-12-01', to: '2027-01-01' });
    expect(parseReportPeriod('year:2026', now)).toMatchObject({ from: '2026-01-01', to: '2027-01-01', label: 'Năm 2026' });
    expect(parseReportPeriod('all', now)).toEqual({ kind: 'all' });
    expect(parseReportPeriod('month:2026-13', now)).toMatchObject({ label: 'Tháng 1/2027' });
  });

  it('định nghĩa: chuẩn hoá, bỏ trùng cột, chặn mã/nguồn/khoá trường lạ', () => {
    expect(normalizeReportDefs([{ id: 'thu', name: ' Thu ', source: 'x:thanh_toan', date_field: 'ngay', sum_fields: ['tien', 'tien'], group_by: '' }]))
      .toEqual([{ id: 'thu', name: 'Thu', source: 'x:thanh_toan', date_field: 'ngay', sum_fields: ['tien'], group_by: null }]);
    expect(() => normalizeReportDefs([{ id: 'A b', name: 'x', source: 'deals', date_field: 'created_at' }])).toThrow(/Mã báo cáo/);
    expect(() => normalizeReportDefs([{ id: 'a', name: 'x', source: 'users', date_field: 'created_at' }])).toThrow(/Bảng nguồn/);
    expect(() => normalizeReportDefs([{ id: 'a', name: 'x', source: 'deals', date_field: "x') OR 1=1" }])).toThrow(/Trường ngày/);
    expect(() => normalizeReportDefs([{ id: 'a', name: 'x', source: 'deals', date_field: 'd' }, { id: 'a', name: 'y', source: 'deals', date_field: 'd' }])).toThrow(/Trùng/);
    expect(() => normalizeReportDefs([{ id: 'sources', name: 'x', source: 'deals', date_field: 'd' }])).toThrow(/đường dẫn hệ thống/);
  });
});
