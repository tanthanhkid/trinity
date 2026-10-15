import { BadRequestException } from '@nestjs/common';
import { IMPORT_MAX_ROWS, parseCsv, parseCsvRecords, parseVnTime } from '../social-csv';

describe('parseCsvRecords (RFC 4180)', () => {
  it('trường trong ngoặc kép: dấu phân cách, xuống dòng, "" thành "', () => {
    const { records } = parseCsvRecords('a,b\n"x, y","dòng 1\ndòng 2"\n"nói ""hi""",z');
    expect(records.map((r) => r.cells)).toEqual([['a', 'b'], ['x, y', 'dòng 1\ndòng 2'], ['nói "hi"', 'z']]);
    // dòng bắt đầu bản ghi tính cả dòng bị trường nhiều dòng chiếm
    expect(records.map((r) => r.line)).toEqual([1, 2, 4]);
  });
  it('CRLF, CR, BOM UTF-8, không xuống dòng cuối, bỏ dòng trống', () => {
    const { records } = parseCsvRecords('﻿a,b\r\n1,2\r\n\r\n3,4');
    expect(records.map((r) => r.cells)).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
    expect(parseCsvRecords('a,b\r1,2').records).toHaveLength(2);
  });
  it('nhận cả dấu phẩy lẫn chấm phẩy theo dòng tiêu đề', () => {
    expect(parseCsvRecords('a;b;c\n1;2;3').delimiter).toBe(';');
    expect(parseCsvRecords('a;b;c\n1;2;3').records[1].cells).toEqual(['1', '2', '3']);
    expect(parseCsvRecords('a,b,c\n1,2,3').delimiter).toBe(',');
    // dấu ; trong ngoặc kép ở tiêu đề không đếm
    expect(parseCsvRecords('"a;b;c",d\n1,2').delimiter).toBe(',');
  });
  it('ô trống cuối dòng và ngoặc kép không đóng', () => {
    expect(parseCsvRecords('a,b,c\n1,,').records[1].cells).toEqual(['1', '', '']);
    expect(() => parseCsvRecords('a,b\n"x,y')).toThrow(BadRequestException);
  });
});

describe('parseCsv — tiêu đề, bí danh, giới hạn', () => {
  it('bí danh có dấu / hoa thường / khoảng trắng → cột chính', () => {
    const { rows } = parseCsv('Nội dung;Kênh;Giờ đăng;Tệp\n"Xin chào";Fanpage;24/10/2026 09:30;a.png\n');
    expect(rows).toEqual([{ row: 2, content: 'Xin chào', channels: ['Fanpage'], scheduled_at: '24/10/2026 09:30', media: ['a.png'] }]);
  });
  it('map đủ cột (VN + EN) và tách kênh theo ; hoặc , , tệp theo ;', () => {
    const csv = ['noi_dung,kenh,gio_dang,tep,binh_luan_dau,tieu_de_youtube,utm', '"Bài 1","Fanpage; 12","2026-10-24 09:30","a.png;b mp4.mp4","bình luận","tiêu đề",thu-10'].join('\n');
    const { rows, unknown_columns } = parseCsv(csv);
    expect(unknown_columns).toEqual([]);
    expect(rows[0]).toEqual({ row: 2, content: 'Bài 1', channels: ['Fanpage', '12'], scheduled_at: '2026-10-24 09:30', media: ['a.png', 'b mp4.mp4'], first_comment: 'bình luận', youtube_title: 'tiêu đề', utm_campaign: 'thu-10' });
    const en = parseCsv('Content,Channels,Scheduled_At,Media,First Comment,YouTube Title,UTM_Campaign\nx,"a,b",2026-10-24 09:30,k,c,t,u').rows[0];
    expect(en).toMatchObject({ content: 'x', channels: ['a', 'b'], media: ['k'], first_comment: 'c', youtube_title: 't', utm_campaign: 'u' });
  });
  it('gio_dang = queue / "hàng đợi" → use_queue, không có scheduled_at', () => {
    const { rows } = parseCsv('noi_dung,gio_dang\na,queue\nb,Hàng đợi\nc,\n');
    expect(rows.map((r) => [r.use_queue, r.scheduled_at])).toEqual([[true, undefined], [true, undefined], [undefined, undefined]]);
  });
  it('cột lạ được báo, thiếu cả content lẫn media / cột trùng / không có dòng dữ liệu ⇒ 400', () => {
    expect(parseCsv('content,ghi_chu\nx,y').unknown_columns).toEqual(['ghi_chu']);
    expect(() => parseCsv('kenh,gio_dang\na,b')).toThrow(/content/);
    expect(() => parseCsv('content,noi_dung\na,b')).toThrow(/trùng/);
    expect(() => parseCsv('content\n')).toThrow(/chưa có dòng dữ liệu/);
    expect(() => parseCsv('  ')).toThrow(/trống/);
  });
  it(`tối đa ${IMPORT_MAX_ROWS} dòng và 1 MB`, () => {
    const ok = ['content', ...Array.from({ length: IMPORT_MAX_ROWS }, (_, i) => `bài ${i}`)].join('\n');
    expect(parseCsv(ok).rows).toHaveLength(IMPORT_MAX_ROWS);
    expect(() => parseCsv(`${ok}\nbài thừa`)).toThrow(/Tối đa 200 dòng/);
    expect(() => parseCsv(`content\n${'x'.repeat(1024 * 1024)}`)).toThrow(/1 MB/);
  });
});

describe('parseVnTime (giờ Việt Nam UTC+7)', () => {
  it('YYYY-MM-DD HH:mm và DD/MM/YYYY HH:mm cùng thời điểm UTC', () => {
    expect(parseVnTime('2026-10-24 09:30').toISOString()).toBe('2026-10-24T02:30:00.000Z');
    expect(parseVnTime('24/10/2026 09:30').toISOString()).toBe('2026-10-24T02:30:00.000Z');
    expect(parseVnTime('4/1/2026 7:05').toISOString()).toBe('2026-01-04T00:05:00.000Z');
  });
  it('00:30 giờ VN rơi sang ngày hôm trước theo UTC; ISO có múi giờ giữ nguyên', () => {
    expect(parseVnTime('2026-10-24 00:30').toISOString()).toBe('2026-10-23T17:30:00.000Z');
    expect(parseVnTime('2026-10-24T09:30').toISOString()).toBe('2026-10-24T02:30:00.000Z');
    expect(parseVnTime('2026-10-24T09:30:00+07:00').toISOString()).toBe('2026-10-24T02:30:00.000Z');
    expect(parseVnTime('2026-10-24T02:30:00Z').toISOString()).toBe('2026-10-24T02:30:00.000Z');
  });
  it('ngày không có thật / sai dạng ⇒ ném', () => {
    for (const bad of ['2026-02-31 09:00', '2026-13-01 09:00', '2026-10-24 25:00', '24-10-2026 09:00', '2026-10-24', 'mai 9h', '']) expect(() => parseVnTime(bad)).toThrow(/không đúng dạng/);
  });
});
