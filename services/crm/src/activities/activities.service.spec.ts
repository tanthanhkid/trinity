import { Prisma } from '@prisma/client';
import { ACTIVITY_SELECT } from './activities.service';

describe('ACTIVITY_SELECT', () => {
  it('chỉ chọn cột có thật của model Activity', () => {
    const scalar = Object.values(Prisma.ActivityScalarFieldEnum) as string[];
    for (const key of Object.keys(ACTIVITY_SELECT)) expect(scalar).toContain(key);
  });
});
