import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { RBAC_META, type AccessMeta } from '@trinity/rbac-nest';
import { ExtensionInputError } from '../extension-errors';
import { ExtensionsController } from '../extensions.controller';
import { ExtensionsService } from '../extensions.service';

const proto = ExtensionsController.prototype as unknown as Record<string, unknown>;
const metaOf = (name: string): AccessMeta => Reflect.getMetadata(RBAC_META, proto[name] as object);

describe('ExtensionsController — quyền', () => {
  it('đọc cần extensions.view; DUYỆT/TỪ CHỐI/deploy/quay lui/tắt/bật cần extensions.approve; mọi route đều khai quyền', () => {
    for (const n of ['list', 'get', 'version', 'logs']) expect(metaOf(n)).toEqual({ kind: 'can', permissions: ['extensions.view'], mode: 'all' });
    for (const n of ['approve', 'reject', 'deploy', 'rollback', 'disable', 'enable']) expect(metaOf(n)).toEqual({ kind: 'can', permissions: ['extensions.approve'], mode: 'all' });
    const routes = Object.getOwnPropertyNames(ExtensionsController.prototype).filter((n) => n !== 'constructor');
    expect(routes).toHaveLength(10);
    for (const n of routes) expect(metaOf(n)?.kind).toBe('can'); // không @Public/@AuthOnly/@Internal
  });
});

describe('ExtensionsController — cờ và lỗi', () => {
  const svc = new ExtensionsService({} as never, {} as never, {} as never);
  const ctrl = new ExtensionsController(svc);
  afterEach(() => void delete process.env.EXTENSIONS_ENABLED);

  it('cờ TẮT ⇒ mọi route 404 (như tính năng không tồn tại)', async () => {
    delete process.env.EXTENSIONS_ENABLED;
    await expect(ctrl.list()).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.approve(1, 1, { userId: 1 } as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.enable(1)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cờ bật ⇒ duyệt dưới danh nghĩa NGƯỜI đang đăng nhập; thiếu version khi quay lui ⇒ 400', async () => {
    process.env.EXTENSIONS_ENABLED = 'true';
    const approve = jest.spyOn(svc, 'approve').mockResolvedValue({ id: 3 } as never);
    expect(await ctrl.approve(3, 2, { userId: 77 } as never)).toEqual({ extension: { id: 3 } });
    expect(approve).toHaveBeenCalledWith(77, 3, 2);
    await expect(ctrl.rollback(3, {})).rejects.toThrow(/Thiếu version/);
  });

  it('ExtensionInputError được filter đổi thành 400 kèm thông điệp tiếng Việt', () => {
    const [filter] = (Reflect.getMetadata('__exceptionFilters__', ExtensionsController) as { new (): { catch(e: Error, h: unknown): void } }[]).map((F) => new F());
    let status = 0;
    let body: { message?: string } = {};
    const res = { status: (n: number) => ((status = n), { json: (b: typeof body) => (body = b) }) };
    filter!.catch(new ExtensionInputError('Mã quá lớn'), { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ExecutionContext);
    expect(status).toBe(400);
    expect(body.message).toBe('Mã quá lớn');
  });
});
