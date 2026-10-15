import {
  decodeMultipartFilename,
  repairMojibakeText,
} from './decode-multipart-filename.helper';

describe('decode-multipart-filename.helper', () => {
  it('should decode Vietnamese filename mojibake từ multer (Latin-1)', () => {
    const original = 'Nguyễn Văn A - Hành chính nhân sự (Tuyển dụng).rar';
    const mojibake = Buffer.from(original, 'utf8').toString('latin1');
    expect(decodeMultipartFilename(mojibake)).toBe(original);
  });

  it('should decode diacritics cơ bản', () => {
    const original = 'hồ sơ khách hàng.pdf';
    const mojibake = Buffer.from(original, 'utf8').toString('latin1');
    expect(decodeMultipartFilename(mojibake)).toBe(original);
  });

  it('should trả nguyên ASCII filename (không đổi)', () => {
    expect(decodeMultipartFilename('contract-2026.pdf')).toBe(
      'contract-2026.pdf',
    );
  });

  it('should trả empty string khi input null/undefined/empty', () => {
    expect(decodeMultipartFilename(null)).toBe('');
    expect(decodeMultipartFilename(undefined)).toBe('');
    expect(decodeMultipartFilename('')).toBe('');
  });

  it('should không double-decode chuỗi đã là Unicode đúng', () => {
    const alreadyUnicode = 'Hồ sơ.pdf';
    expect(decodeMultipartFilename(alreadyUnicode)).toBe(alreadyUnicode);
  });

  it('should giữ nguyên khi bytes không phải UTF-8 hợp lệ', () => {
    const invalid = '\xC3\x28';
    expect(decodeMultipartFilename(invalid)).toBe(invalid);
  });

  it('should strip CR/LF (ngăn HTTP header injection)', () => {
    const attack = 'evil.pdf\r\nSet-Cookie: session=hacked';
    const result = decodeMultipartFilename(attack);
    expect(result).not.toMatch(/[\r\n]/);
    expect(result).toContain('evil.pdf');
  });

  it('should strip NUL byte (ngăn truncation exploit)', () => {
    expect(decodeMultipartFilename('hidden.php\x00.pdf')).toBe(
      'hidden.php_.pdf',
    );
  });

  it('should strip path separators / và \\ (ngăn traversal)', () => {
    expect(decodeMultipartFilename('../../etc/passwd')).toBe(
      '.._.._etc_passwd',
    );
    expect(decodeMultipartFilename('..\\..\\windows\\system32')).toBe(
      '.._.._windows_system32',
    );
  });

  it('should sanitize sau khi decode mojibake (CR/LF trong Latin-1 bytes)', () => {
    // Attacker crafts UTF-8 filename → encoded as Latin-1 bytes → contains CRLF
    // after double-decode. Helper must sanitize result, not just raw input.
    const originalWithCrlf = 'Lê Thị\r\nX-Inject: 1.pdf';
    const mojibake = Buffer.from(originalWithCrlf, 'utf8').toString('latin1');
    const result = decodeMultipartFilename(mojibake);
    expect(result).not.toMatch(/[\r\n]/);
    expect(result).toContain('Lê Thị');
  });

  it('should giữ diacritics tiếng Việt khi sanitize', () => {
    const ok = 'Nguyễn Văn A - Hồ sơ 2026.pdf';
    expect(decodeMultipartFilename(ok)).toBe(ok);
  });

  it('should trim whitespace đầu/cuối', () => {
    expect(decodeMultipartFilename('  file.pdf  ')).toBe('file.pdf');
  });

  it('should handle filename dài (>255 bytes)', () => {
    const long = 'a'.repeat(300) + '.pdf';
    expect(decodeMultipartFilename(long)).toBe(long);
  });

  it('should warn qua Logger khi sanitize strip ký tự unsafe', () => {
    const warnSpy = jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    decodeMultipartFilename('evil.pdf\r\n');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/sanitized.*len=/),
    );
    warnSpy.mockRestore();
  });

  it('should KHÔNG warn khi filename sạch (không strip)', () => {
    const warnSpy = jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    decodeMultipartFilename('Hồ sơ.pdf');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('repairMojibakeText (sửa tên file mẫu hợp đồng cũ)', () => {
  it('should sửa mojibake tên file đã lưu DB về tiếng Việt đúng', () => {
    const original = 'Quy chế lương 2026.docx';
    const mojibake = Buffer.from(original, 'utf8').toString('latin1');
    expect(repairMojibakeText(mojibake)).toBe(original);
  });

  it('should sửa mojibake phụ lục HĐLĐ', () => {
    const original = 'Phụ lục hợp đồng lao động mới nhất năm 2026.docx';
    const mojibake = Buffer.from(original, 'utf8').toString('latin1');
    expect(repairMojibakeText(mojibake)).toBe(original);
  });

  it('IDEMPOTENT — tên UTF-8 đúng (ký tự > 0xFF) giữ NGUYÊN', () => {
    const ok = 'HỢP ĐỒNG LAO ĐỘNG 2026.docx';
    expect(repairMojibakeText(ok)).toBe(ok);
  });

  it('should trả nguyên ASCII (không đổi)', () => {
    expect(repairMojibakeText('contract-2026.pdf')).toBe('contract-2026.pdf');
  });

  it('should trả empty string khi null/undefined/empty', () => {
    expect(repairMojibakeText(null)).toBe('');
    expect(repairMojibakeText(undefined)).toBe('');
    expect(repairMojibakeText('')).toBe('');
  });

  it('should KHÔNG sanitize ký tự (khác decodeMultipartFilename — giữ text hiển thị)', () => {
    // Tên hiển thị giữ nguyên dấu cách + ký tự, KHÔNG strip như storage key.
    expect(repairMojibakeText('Hợp đồng (bản mới).pdf')).toBe(
      'Hợp đồng (bản mới).pdf',
    );
  });
});
