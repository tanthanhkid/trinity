import { ActionUserError } from '../action-types';
import { parseFeatures } from '../workspace-spec';

describe('parseFeatures — khoá tính năng đã gỡ', () => {
  it('google_sheets bị bỏ qua, không lỗi; khoá lạ khác vẫn lỗi', () => {
    expect(parseFeatures(['zalo_oa', 'google_sheets'])).toEqual(['zalo_oa']);
    expect(() => parseFeatures(['khong_co'])).toThrow(ActionUserError);
  });
});
