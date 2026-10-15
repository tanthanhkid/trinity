import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RBAC_META } from '@trinity/rbac-nest';
import { ORG_FEATURE_KEYS, DEFAULT_OFF_FEATURES } from '@trinity/rbac';
import { OrgFeaturesController } from './org-features.controller';
import { OrgFeaturesService } from './org-features.service';
import { UpdateOrgFeaturesDto } from './dto/org-features.dto';

const meta = (m: keyof OrgFeaturesController) =>
  Reflect.getMetadata(RBAC_META, OrgFeaturesController.prototype[m] as unknown as () => void);

describe('OrgFeatures — RBAC metadata', () => {
  it('GET = AuthOnly (mọi người cần để dựng menu)', () => {
    expect(meta('get')).toEqual({ kind: 'auth' });
  });
  it('PUT = Can(settings.features)', () => {
    expect(meta('update')).toEqual({ kind: 'can', permissions: ['settings.features'], mode: 'all' });
  });
});

describe('UpdateOrgFeaturesDto', () => {
  it('đủ khoá của danh mục ORG_FEATURES', async () => {
    const dto = plainToInstance(UpdateOrgFeaturesDto, Object.fromEntries(ORG_FEATURE_KEYS.map((k) => [k, false])));
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  });
  it('khoá lạ → lỗi (forbidNonWhitelisted)', async () => {
    const dto = plainToInstance(UpdateOrgFeaturesDto, { kanban: false, hack: true });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(0);
  });
  it('giá trị không phải boolean → lỗi', async () => {
    const dto = plainToInstance(UpdateOrgFeaturesDto, { kanban: 'no' });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});

describe('OrgFeaturesService', () => {
  const make = (stored: string | null) => {
    const upsert = jest.fn();
    const prisma = {
      setting: {
        findUnique: jest.fn().mockResolvedValue(stored === null ? null : { value: stored }),
        upsert,
      },
    };
    return { svc: new OrgFeaturesService(prisma as never), upsert, prisma };
  };

  it('chưa lưu → bật hết', async () => {
    const { svc } = make(null);
    const f = await svc.get();
    expect(ORG_FEATURE_KEYS.every((k) => f[k] === !DEFAULT_OFF_FEATURES.has(k))).toBe(true);
  });
  it('JSON rác → bật hết (fail-open)', async () => {
    const { svc } = make('{oops');
    expect((await svc.get()).kanban).toBe(true);
  });
  it('lỗi DB khi đọc → bật hết', async () => {
    const { svc, prisma } = make(null);
    prisma.setting.findUnique.mockRejectedValue(new Error('db'));
    expect((await svc.get()).kanban).toBe(true);
  });
  it('update một phần: giữ khoá vắng, chỉ đổi khoá gửi lên (DTO dựng bằng class)', async () => {
    const { svc, upsert } = make(JSON.stringify({ newsfeed: false }));
    const dto = plainToInstance(UpdateOrgFeaturesDto, { kanban: false });
    const out = await svc.update(dto, 7);
    expect(out.kanban).toBe(false);
    expect(out.newsfeed).toBe(false);
    expect(out.attendance).toBe(true);
    const saved = JSON.parse(upsert.mock.calls[0][0].update.value);
    expect(saved).toMatchObject({ kanban: false, newsfeed: false });
    expect(upsert.mock.calls[0][0].update.updated_by).toBe(7);
  });
});

describe('OrgFeaturesService — runtime serverless', () => {
  const make = (stored: string | null) => {
    const upsert = jest.fn();
    const prisma = {
      setting: {
        findUnique: jest.fn().mockResolvedValue(stored === null ? null : { value: stored }),
        upsert,
      },
    };
    return { svc: new OrgFeaturesService(prisma as never), upsert };
  };
  const prev = process.env.TRINITY_RUNTIME;
  afterEach(() => {
    if (prev === undefined) delete process.env.TRINITY_RUNTIME;
    else process.env.TRINITY_RUNTIME = prev;
  });

  it('serverless: không tính năng nào bị khoá, GET không có `locked`', async () => {
    process.env.TRINITY_RUNTIME = 'serverless';
    const f = await make(JSON.stringify({ kanban: true })).svc.get();
    expect(f.kanban).toBe(true);
    expect(f).not.toHaveProperty('locked');
  });
  it('serverless: PUT bật/tắt khoá bất kỳ vẫn được', async () => {
    process.env.TRINITY_RUNTIME = 'serverless';
    const { svc } = make(null);
    const out = await svc.update(plainToInstance(UpdateOrgFeaturesDto, { newsfeed: false }), 1);
    expect(out.newsfeed).toBe(false);
  });
});
