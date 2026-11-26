/**
 * Multi-tenant: job nền chạy cho TỪNG công ty, trạng thái trong RAM / khoá lưu trữ không lẫn
 * giữa hai công ty có cùng id (user 3, cấu hình 1…).
 */
jest.mock('../../../../../../packages/prisma/src/tenant/platform', () => ({
  ...jest.requireActual('../../../../../../packages/prisma/src/tenant/platform'),
  listActiveCompanies: jest.fn(async () => [
    { id: 1, schema: 'public' },
    { id: 5, schema: 'c_5' },
  ]),
}));

import { companyRef, currentCompanyId, runWithCompany } from '@trinity/prisma';
import { tenantTimerTick } from '../tenant-timer';
import { companyStorageKey } from '../../../storage/storage.service';
import { FacebookFlowsJob } from '../../../facebook/facebook-flows.job';
import { signMediaLink, verifyMediaLink } from '../../../social/social-media-link';

const OLD_MT = process.env.MULTI_TENANT;
const OLD_SECRET = process.env.JWT_SECRET;
beforeAll(() => {
  process.env.MULTI_TENANT = 'true';
  process.env.JWT_SECRET = 'tenant-isolation-test';
});
afterAll(() => {
  if (OLD_MT === undefined) delete process.env.MULTI_TENANT;
  else process.env.MULTI_TENANT = OLD_MT;
  if (OLD_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = OLD_SECRET;
});

const logger = { error: jest.fn() };

describe('tenantTimerTick — timer nền chạy cho từng công ty', () => {
  it('mỗi lượt gọi fn một lần cho mỗi công ty, trong đúng ngữ cảnh công ty', async () => {
    const seen: Array<number | null> = [];
    const tick = tenantTimerTick(logger, 'test', async () => {
      seen.push(currentCompanyId());
    });
    expect(currentCompanyId()).toBeNull(); // timer: ngoài mọi request
    await tick();
    expect(seen).toEqual([1, 5]);
  });

  it('lượt trước chưa xong ⇒ lượt sau bỏ qua (không chạy chồng)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fn = jest.fn(() => gate);
    const tick = tenantTimerTick(logger, 'test', fn);
    const first = tick();
    await tick(); // bỏ qua ngay
    release();
    await first;
    expect(fn).toHaveBeenCalledTimes(2); // 2 công ty của lượt đầu, lượt hai không chạy
  });

  it('lỗi của một công ty không chặn công ty khác', async () => {
    const seen: number[] = [];
    const tick = tenantTimerTick(logger, 'test', async () => {
      const id = currentCompanyId() as number;
      if (id === 1) throw new Error('hỏng');
      seen.push(id);
    });
    await tick();
    expect(seen).toEqual([5]);
  });

  it('job thật (FacebookFlowsJob): timer gọi runDue cho từng công ty', async () => {
    const companies: Array<number | null> = [];
    const flows = { runDue: jest.fn(async () => void companies.push(currentCompanyId())) };
    const job = new FacebookFlowsJob(flows as never);
    await (job as unknown as { timerTick: () => Promise<void> }).timerTick();
    expect(companies).toEqual([1, 5]);
  });
});

describe('companyStorageKey — file công ty ≠1 nằm dưới c<id>/', () => {
  it('công ty 1 giữ khoá cũ, công ty 5 có tiền tố', () => {
    expect(runWithCompany(companyRef(1), () => companyStorageKey('contracts/3/a.pdf'))).toBe('contracts/3/a.pdf');
    expect(runWithCompany(companyRef(5), () => companyStorageKey('contracts/3/a.pdf'))).toBe('c5/contracts/3/a.pdf');
  });

  it('công ty 1 không với tới được file công ty khác bằng khoá có tiền tố', () => {
    expect(() => runWithCompany(companyRef(1), () => companyStorageKey('c5/contracts/3/a.pdf'))).toThrow();
  });

  it('công ty 5 gõ khoá của công ty 7 vẫn chỉ trỏ vào thư mục của chính nó', () => {
    expect(runWithCompany(companyRef(5), () => companyStorageKey('c7/x.pdf'))).toBe('c5/c7/x.pdf');
  });

  it('không có ngữ cảnh công ty ⇒ ném (fail-closed)', () => {
    expect(() => companyStorageKey('contracts/3/a.pdf')).toThrow();
  });
});

describe('link tệp công khai mạng xã hội mang công ty', () => {
  it('token ký trong công ty 5 trả companyId 5', () => {
    const t = runWithCompany(companyRef(5), () => signMediaLink({ key: 'social/u3_a.jpg', content_type: 'image/jpeg' }, 1_000));
    expect(verifyMediaLink(t, 1_000)).toEqual({ key: 'social/u3_a.jpg', contentType: 'image/jpeg', companyId: 5 });
  });
});
