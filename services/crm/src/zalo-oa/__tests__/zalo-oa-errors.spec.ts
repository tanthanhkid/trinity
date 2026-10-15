import { ZALO_TIER_MESSAGE, ZaloApiError, describeZaloError } from '../zalo-oa.errors';

describe('describeZaloError', () => {
  it('tin tư vấn bị -224 ⇒ OA cần nâng gói Tier, không phải lỗi mẫu ZNS', () => {
    expect(describeZaloError(new ZaloApiError(-224, 'x'), 'consult')).toBe(ZALO_TIER_MESSAGE);
    expect(describeZaloError(new ZaloApiError(-224, 'x'), 'zns')).toMatch(/Mẫu ZNS/);
  });

  it('Zalo nói rõ cần nâng gói ⇒ báo Tier ở mọi kênh', () => {
    const e = new ZaloApiError(-999, 'The OA needs to upgrade OA Tier Package to use this feature. See more on https://zalo.cloud/oa/pricing');
    expect(describeZaloError(e, 'zns')).toBe(ZALO_TIER_MESSAGE);
  });

  it('lỗi token vẫn ưu tiên báo kết nối lại', () => {
    expect(describeZaloError(new ZaloApiError(-216, 'upgrade OA Tier'), 'consult')).toMatch(/kết nối lại/);
  });
});
