import { cronMatches, parseCron, validateSchedule } from '../cron';
import { ExtensionInputError } from '../extension-errors';
import { isInternalHost, parseManifest } from '../manifest';

describe('manifest', () => {
  const ok = { net: ['api.example.com', 'sheets.googleapis.com:443'], tables: { read: ['a'], write: ['b'] } };

  it('job hợp lệ: chuẩn hoá, mặc định giới hạn không bị ép', () => {
    expect(parseManifest('job', { ...ok, schedule: ' 0   8 * * * ' })).toEqual({ ...ok, schedule: '0 8 * * *' });
  });

  it.each(['localhost:3000', '127.0.0.1:5432', '[::1]:80', '10.1.2.3', '192.168.1.5', '172.20.0.1', '169.254.169.254', 'db.internal', 'x.local', '0.0.0.0:4000'])('từ chối địa chỉ nội bộ %s', (h) => {
    expect(isInternalHost(h)).toBe(true);
    expect(() => parseManifest('tool', { net: [h], tables: {} })).toThrow(ExtensionInputError);
  });

  it.each(['*', '*.example.com', 'a b', 'a,b.com', '--allow-all', 'x.com/path', ''])('từ chối host chèn cờ/ký tự đại diện %p', (h) => {
    expect(() => parseManifest('tool', { net: [h], tables: {} })).toThrow(/không hợp lệ|nội bộ/);
  });

  it.each(['127.0.0.1.nip.io', '10-0-0-5.sslip.io', 'foo.localtest.me', '2130706433', '0x7f000001', '0177.0.0.1', 'a.192.168.1.1.example.com', '100.64.0.1'])('từ chối kiểu né chặn nội bộ %s', (h) => {
    expect(isInternalHost(h)).toBe(true);
  });

  it.each(['[0:0:0:0:0:0:0:1]', '[0::1]', '[::ffff:7f00:1]', '[::ffff:127.0.0.1]:80', '[::ffff:10.0.0.1]', '[::]', '[fd12:3456::1]', '[fe80::1]', '[64:ff9b::a00:1]', '[::7f00:1]', '[1:2:3:4:5:6:7:8:9]'])('từ chối IPv6 viết khác của địa chỉ nội bộ %s', (h) => {
    expect(isInternalHost(h)).toBe(true);
  });

  it('IPv6 công cộng không bị coi là nội bộ', () => {
    for (const h of ['[2001:4860:4860::8888]', '[::ffff:8.8.8.8]', '[2606:4700::1111]:443']) expect(isInternalHost(h)).toBe(false);
  });

  it('host công cộng không bị coi là nội bộ', () => {
    for (const h of ['api.example.com', '8.8.8.8', '172.32.0.1', '1.1.1.1:443']) expect(isInternalHost(h)).toBe(false);
  });

  it('job cần lịch, tool cần schema; sai loại thì từ chối trường không thuộc loại đó', () => {
    expect(() => parseManifest('job', ok)).toThrow(/cần "schedule"/);
    expect(() => parseManifest('tool', { ...ok, schedule: '0 8 * * *' })).toThrow(/Chỉ job/);
    expect(() => parseManifest('job', { ...ok, schedule: '0 8 * * *', input_schema: { type: 'object' } })).toThrow(/Chỉ tool/);
    expect(parseManifest('tool', ok).input_schema).toEqual({ type: 'object', properties: {} });
    expect(() => parseManifest('tool', { ...ok, input_schema: { type: 'string' } })).toThrow(/kiểu object/);
  });

  it('tên bảng, giới hạn tài nguyên', () => {
    expect(() => parseManifest('tool', { net: [], tables: { read: ['Bảng Lạ'] } })).toThrow(/Tên bảng/);
    expect(() => parseManifest('tool', { net: [], tables: {}, limits: { timeoutMs: 9e9 } })).toThrow(/timeoutMs/);
    expect(() => parseManifest('tool', { net: [], tables: {}, limits: { memoryMb: 4096 } })).toThrow(/memoryMb/);
    expect(parseManifest('tool', { net: [], tables: {}, limits: { timeoutMs: 5000, memoryMb: 64 } }).limits).toEqual({ timeoutMs: 5000, memoryMb: 64 });
  });
});

describe('cron (giờ Việt Nam)', () => {
  // 01:00 UTC = 08:00 VN
  const vn8 = new Date(Date.UTC(2026, 9, 12, 1, 0));
  it('khớp đúng giờ VN', () => {
    expect(cronMatches(parseCron('0 8 * * *'), vn8)).toBe(true);
    expect(cronMatches(parseCron('0 9 * * *'), vn8)).toBe(false);
    expect(cronMatches(parseCron('*/15 8 * * 1'), vn8)).toBe(true); // 12/10/2026 là thứ Hai
    expect(cronMatches(parseCron('0 8 * * 2-5'), vn8)).toBe(false);
    expect(cronMatches(parseCron('0,30 7-9 * * *'), vn8)).toBe(true);
  });
  it('cú pháp sai / ngoài phạm vi', () => {
    for (const e of ['0 8 * *', '61 8 * * *', '0 24 * * *', 'a b c d e', '*/0 * * * *', '5-2 * * * *']) expect(() => parseCron(e)).toThrow(ExtensionInputError);
  });
  it('chặn lịch dày hơn 5 phút/lần', () => {
    expect(() => validateSchedule('* * * * *')).toThrow(/quá dày/);
    expect(() => validateSchedule('0,3 * * * *')).toThrow(/quá dày/);
    expect(() => validateSchedule('* * * * 1')).toThrow(/quá dày/); // thứ không rơi vào 2 ngày đầu cửa sổ cũ
    expect(() => validateSchedule('*/5 * * * *')).not.toThrow();
    expect(() => validateSchedule('15 3 * * 1')).not.toThrow();
  });
});
