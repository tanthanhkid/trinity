import { can, ORG_FEATURES, type OrgFeatureKey } from '@trinity/rbac';
import { isObjectVisible, loadObjectAccess } from '../../../custom-objects/custom-object-access';
import { wrapData } from '../ai-output';
import { SETUP_INTERVIEW, SETUP_STEPS } from './setup-guide';
import { ToolUserError, type ToolDef } from './tool-types';
import { buildConnectPrompt, CONNECT_AGENTS, isConnectAgent } from '../../../setup/connect-prompts';
import { mcpResourceUrl, publicBaseUrl } from '../../oauth/oauth-config';

export const getSetupGuideTool: ToolDef = {
  name: 'get_setup_guide',
  title: 'Hướng dẫn dựng CRM + kịch bản phỏng vấn / Setup guide',
  description:
    'GỌI ĐẦU TIÊN khi bắt đầu với một hệ thống Trinity. Trả trạng thái dựng (chua_dung = CRM trống, cần phỏng vấn và dựng; dang_dung = đã dựng gói, đang nhập dữ liệu; da_dung = đang dùng), ' +
    'kịch bản phỏng vấn tiếng Việt, các bước dựng (propose_workspace → import_records → complete_setup), bảng/màn/module đang có. Chỉ đọc. / ' +
    'CALL FIRST: setup status, Vietnamese interview script and the steps to build the CRM. ' +
    `Truyền agent (${CONNECT_AGENTS.map((a) => a.key).join(', ')}) để nhận thêm connect_prompt: hướng dẫn gắn Trinity vào agent đó và rule/skill nên tạo. / Pass agent to also get connect_prompt for that client.`,
  permissions: [],
  input: (z) => ({ agent: z.enum(CONNECT_AGENTS.map((a) => a.key) as [string, ...string[]]).optional().describe('Agent đang dùng, để nhận connect_prompt / Client in use, to get connect_prompt') }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal }) {
    const canBuild = can(principal.user.grants, 'custom_objects.manage');
    const [status, allObjects, views, features, roles, access] = await Promise.all([
      deps.setup.get(),
      deps.prisma.customObject.findMany({
        where: { deleted_at: null },
        select: { key: true, label_plural: true, code_prefix: true, is_active: true, deleted_at: true, visible_role_ids: true },
        take: 60,
      }),
      deps.prisma.customView.count({ where: { deleted_at: null } }),
      deps.orgFeatures.get(),
      // Tên vai trò chỉ phục vụ menu.roles của propose_workspace/set_menu — người không dựng được cấu trúc không cần.
      canBuild ? deps.prisma.role.findMany({ select: { name: true }, orderBy: { id: 'asc' }, take: 50 }) : Promise.resolve([] as { name: string }[]),
      loadObjectAccess(deps.prisma, principal.user),
    ]);
    // Cùng bộ lọc với describeCustomTables: bảng ẩn (visible_role_ids/tắt) hoặc người không có custom_records.view thì không lộ tên/khoá/mã.
    const objects = can(principal.user.grants, 'custom_records.view') || canBuild
      ? allObjects.filter((o) => isObjectVisible(o, access))
      : [];
    const on = (Object.keys(ORG_FEATURES) as OrgFeatureKey[]).filter((k) => features[k]).map((k) => ORG_FEATURES[k].label);
    const out = wrapData({
      status,
      can_build: canBuild,
      next: status === 'chua_dung' ? 'Phỏng vấn khách rồi propose_workspace.' : status === 'dang_dung' ? 'Nhập dữ liệu (import_records) rồi complete_setup.' : 'Hệ thống đang dùng — chỉ đổi cấu trúc khi khách yêu cầu rõ.',
      interview: SETUP_INTERVIEW,
      steps: SETUP_STEPS,
      current: {
        tables: objects.map((o) => `${o.label_plural} [${o.key}]${o.code_prefix ? ` mã ${o.code_prefix}001…` : ''}`), views, modules_on: on,
        // Vai trò CÓ THẬT — dùng đúng tên này cho menu.roles (propose_workspace / set_menu); tên lạ bị từ chối ngay lúc đề xuất.
        roles: roles.map((r) => r.name),
        core_codes: { contacts: 'KH001…', deals: 'DL001…', tasks: 'CV001…' },
      },
      modules: Object.fromEntries(Object.entries(ORG_FEATURES).map(([k, v]) => [k, v.label])),
    });
    // Prompt nối do chính máy chủ sinh (không chứa dữ liệu người dùng) ⇒ gắn sau wrapData để không bị cắt 500 ký tự.
    const base = publicBaseUrl();
    if (isConnectAgent(args.agent) && base) (out.data as Record<string, unknown>).connect_prompt = buildConnectPrompt(args.agent, mcpResourceUrl(base));
    return { structured: out, text: JSON.stringify(out) };
  },
};

export const completeSetupTool: ToolDef = {
  name: 'complete_setup',
  title: 'Hoàn tất dựng CRM / Complete setup',
  description:
    'Đánh dấu ĐÃ DỰNG XONG (dang_dung → da_dung) sau khi đã dựng gói propose_workspace và nhập dữ liệu: bỏ mục "Bắt đầu" khỏi menu, mở CRM cho cả công ty. ' +
    'Chỉ đổi cờ trạng thái; chỉ quản trị viên; chỉ gọi khi khách đồng ý là xong. / Marks setup as done (admins only).',
  permissions: ['custom_objects.manage'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: () => ({}),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(_args, { deps, principal }) {
    const status = await deps.setup.get();
    if (status === 'chua_dung') throw new ToolUserError('Chưa dựng: hãy phỏng vấn và dựng gói bằng propose_workspace (nếu workspace bật chế độ duyệt: chờ khách duyệt) rồi mới complete_setup.');
    if (status === 'dang_dung') await deps.setup.set('da_dung', principal.userId);
    const out = wrapData({ status: 'da_dung', message: 'Đã hoàn tất dựng CRM. Menu đầy đủ đã hiện cho mọi người.' });
    return { structured: out, text: JSON.stringify(out) };
  },
};

export const listStructureVersionsTool: ToolDef = {
  name: 'list_structure_versions',
  title: 'Các phiên bản cấu trúc đã lưu / List structure versions',
  description:
    'Liệt kê các phiên bản cấu trúc bảng tuỳ biến Trinity tự lưu TRƯỚC mỗi lần duyệt đổi cấu trúc (mới nhất trước): id, thao tác, tóm tắt, thời điểm. ' +
    'Dùng id với restore_structure_version để quay lui. Chỉ quản trị viên. Chỉ đọc. / Lists saved structure versions (admins only).',
  permissions: ['custom_objects.manage'],
  input: (z) => ({ limit: z.number().int().min(1).max(50).optional() }),
  output: (z) => ({ notice: z.string(), data: z.object({ versions: z.array(z.record(z.string(), z.unknown())) }) }),
  async run(args, { deps }) {
    const rows = await deps.versions.list(typeof args.limit === 'number' ? args.limit : 20);
    const out = wrapData({ versions: rows.map((r) => ({ id: r.id, tool: r.tool, summary: r.summary, created_at: r.created_at.toISOString() })) });
    return { structured: out, text: JSON.stringify(out) };
  },
};
