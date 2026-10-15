import { actionToolByName } from '../actions/action-registry';
import { listSocialSnippetsTool, saveSocialSnippetTool } from '../tools/social-tools';

const user = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} } as never;

function deps(rows: Array<Record<string, unknown>> = []) {
  const snippets = {
    list: jest.fn(async () => rows),
    create: jest.fn(async (_u: unknown, i: any) => ({ id: 9, is_default: false, ...i })),
    update: jest.fn(async (id: number, i: any) => ({ id, kind: 'signature', name: 'a', content: 'b', is_default: false, ...i })),
  };
  return { social: { snippets, posts: {}, drafts: {}, queue: {}, accounts: {} }, orgFeatures: { isEnabled: jest.fn(async () => true) } } as any;
}
const ctx = (d: any) => ({ deps: d, baseUrl: 'https://crm.example.com', principal: { user } }) as never;

describe('list_social_snippets', () => {
  it('quyền social.post, chỉ đọc, gom theo loại', async () => {
    expect(listSocialSnippetsTool.permissions).toEqual(['social.post']);
    expect(listSocialSnippetsTool.scope).toBeUndefined();
    const d = deps([
      { id: 1, kind: 'hashtags', name: 'Khai giảng', content: '#a #b', is_default: false },
      { id: 2, kind: 'signature', name: 'Mặc định', content: 'Trân trọng', is_default: true },
    ]);
    const r = await listSocialSnippetsTool.run({}, ctx(d));
    const data = r.structured.data as any;
    expect(data.hashtags).toEqual([{ id: 1, name: 'Khai giảng', content: '#a #b', is_default: false }]);
    expect(data.signatures).toEqual([{ id: 2, name: 'Mặc định', content: 'Trân trọng', is_default: true }]);
  });
});

describe('save_social_snippet', () => {
  it('ghi trực tiếp, scope crm.write, không qua duyệt', () => {
    expect(saveSocialSnippetTool.scope).toBe('crm.write');
    expect(actionToolByName('save_social_snippet')).toBeUndefined();
  });
  it('không có snippet_id ⇒ tạo; có ⇒ chỉ sửa trường đã gửi', async () => {
    const d = deps();
    await saveSocialSnippetTool.run({ kind: 'hashtags', name: 'A', content: 'x' }, ctx(d));
    expect(d.social.snippets.create).toHaveBeenCalledWith(user, { kind: 'hashtags', name: 'A', content: 'x' });
    await saveSocialSnippetTool.run({ snippet_id: 4, is_default: true }, ctx(d));
    expect(d.social.snippets.update).toHaveBeenCalledWith(4, { is_default: true });
  });
  it('lỗi 4xx của service thành lỗi người dùng', async () => {
    const d = deps();
    d.social.snippets.create.mockRejectedValueOnce(Object.assign(new Error('Tối đa 100 mẫu.'), { status: 400 }));
    await expect(saveSocialSnippetTool.run({ kind: 'signature', name: 'a', content: 'b' }, ctx(d))).rejects.toThrow('Tối đa 100 mẫu.');
  });
});
