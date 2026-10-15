import { ForbiddenException } from '@nestjs/common';
import { resolveMarketingReportScopeIds } from '../marketing-report-scope.helper';

describe('resolveMarketingReportScopeIds', () => {
  it('owner "all" + không override => null (không giới hạn)', () => {
    expect(resolveMarketingReportScopeIds('all')).toBeNull();
  });

  it('owner "all" + override => [override]', () => {
    expect(resolveMarketingReportScopeIds('all', 42)).toEqual([42]);
  });

  it('owner mảng + không override => trả nguyên mảng', () => {
    expect(resolveMarketingReportScopeIds([7, 8])).toEqual([7, 8]);
  });

  it('owner mảng + override TRONG owner => [override]', () => {
    expect(resolveMarketingReportScopeIds([7, 8], 8)).toEqual([8]);
  });

  it('owner mảng + override NGOÀI owner => 403 (KHÔNG im lặng bỏ qua)', () => {
    expect(() => resolveMarketingReportScopeIds([7, 8], 99)).toThrow(ForbiddenException);
  });

  it('owner rỗng ([]) => trả mảng rỗng (0 kết quả, KHÔNG tự nới)', () => {
    expect(resolveMarketingReportScopeIds([])).toEqual([]);
  });
});
