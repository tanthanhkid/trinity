import { BadRequestException } from '@nestjs/common';
import { BASIC_FEATURES, ORG_FEATURE_GROUPS, ORG_FEATURES, isOrgFeatureKey, type OrgFeatureKey } from '@trinity/rbac';
import { wrapData } from '../ai-output';
import { isUserConfirmation } from '../actions/user-confirmation';
import { ToolUserError, type ToolDef } from './tool-types';

const KEY_LIST = Object.entries(ORG_FEATURES).map(([k, v]) => `${k}=${v.label}`).join('; ');

/** Tính năng của tổ chức theo nhóm, kèm trạng thái bật/tắt (đã tính gói + khoá máy chủ). */
export const listFeaturesTool: ToolDef = {
  name: 'list_features',
  title: 'Tính năng đang bật / List features',
  description:
    'Liệt kê các tính năng có sẵn của Trinity theo nhóm (Cơ bản, Kênh & hộp thư, Bán hàng, Nhân sự, Nâng cao): khoá, tên, mô tả một dòng, đang bật hay tắt, lý do bị khoá nếu có. ' +
    'Tính năng tắt thì ẩn khỏi menu và Cài đặt của cả công ty; dữ liệu vẫn giữ. Chỉ đọc. / Lists built-in features by group with on/off state. Read-only.',
  permissions: [],
  input: () => ({}),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(_args, { deps }) {
    const f = await deps.orgFeatures.get();
    const locked = f.locked ?? {};
    const groups = ORG_FEATURE_GROUPS.map((g) => ({
      group: g.key,
      label: g.label,
      features: (Object.keys(ORG_FEATURES) as OrgFeatureKey[])
        .filter((k) => ORG_FEATURES[k].group === g.key)
        .map((k) => ({ key: k, label: ORG_FEATURES[k].label, description: ORG_FEATURES[k].description, enabled: f[k] !== false, ...(locked[k] ? { locked: locked[k] } : {}) })),
    }));
    const out = wrapData({ basic: BASIC_FEATURES, groups });
    return { structured: out, text: JSON.stringify(out) };
  },
};

/** Bật/tắt tính năng cho cả công ty. Bật chạy ngay; tắt (ẩn với mọi người) cần lời đồng ý của người dùng. */
export const setFeaturesTool: ToolDef = {
  name: 'set_features',
  title: 'Bật/tắt tính năng / Turn features on or off',
  description:
    'Bật hoặc tắt tính năng có sẵn cho cả công ty (khoá lấy từ list_features). Bật thì mục menu và Cài đặt liên quan hiện ra ngay. ' +
    'Tắt thì ẩn với mọi người nhưng không xoá dữ liệu; vì ảnh hưởng cả công ty nên khi có khoá trong disable, confirmed_by_user là lời người dùng đồng ý tắt, chép nguyên văn. ' +
    `Khoá hợp lệ: ${KEY_LIST}. Chỉ quản trị viên. / Turns built-in features on or off for the whole company; turning off needs the user's confirmation. Admins only.`,
  permissions: ['settings.features'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: (z) => ({
    enable: z.array(z.string().max(32)).max(25).optional().describe('Khoá tính năng cần bật / Feature keys to turn on'),
    disable: z.array(z.string().max(32)).max(25).optional().describe('Khoá tính năng cần tắt / Feature keys to turn off'),
    confirmed_by_user: z.string().max(300).optional()
      .describe('Bắt buộc khi có disable: lời người dùng đồng ý tắt, chép nguyên văn (vd "ok tắt đi"). / Required with disable: the user\'s own words agreeing.'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal }) {
    const keys = (v: unknown): OrgFeatureKey[] => {
      const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()) : [];
      const bad = list.filter((k) => !isOrgFeatureKey(k));
      if (bad.length) throw new ToolUserError(`Khoá tính năng không có: ${bad.join(', ')}. Khoá hợp lệ: ${KEY_LIST}. / Unknown feature keys.`);
      return [...new Set(list as OrgFeatureKey[])];
    };
    const on = keys(args.enable);
    const off = keys(args.disable);
    const both = on.filter((k) => off.includes(k));
    if (both.length) throw new ToolUserError(`Một khoá vừa bật vừa tắt: ${both.join(', ')}. / Same key in enable and disable.`);
    if (on.length + off.length === 0) throw new ToolUserError('Chưa có khoá nào trong enable hoặc disable. / Nothing to change.');
    if (off.length && !isUserConfirmation(args.confirmed_by_user)) {
      const said = typeof args.confirmed_by_user === 'string' && args.confirmed_by_user.trim() ? `“${args.confirmed_by_user.trim().slice(0, 80)}”` : '(trống)';
      throw new ToolUserError(
        `Chưa đổi gì: tắt ${off.map((k) => ORG_FEATURES[k].label).join(', ')} sẽ ẩn với cả công ty (dữ liệu vẫn giữ). ` +
        `Hỏi người dùng rồi gửi lại với confirmed_by_user là lời họ đồng ý (hiện là ${said}). / Nothing changed: turning features off needs the user's confirmation.`,
      );
    }
    const dto = Object.fromEntries([...on.map((k) => [k, true]), ...off.map((k) => [k, false])]);
    let after: Record<string, unknown>;
    try {
      after = (await deps.orgFeatures.update(dto as never, principal.userId)) as unknown as Record<string, unknown>;
    } catch (e) {
      if (e instanceof BadRequestException) throw new ToolUserError(e.message);
      throw e;
    }
    const state = (k: OrgFeatureKey) => ({ key: k, label: ORG_FEATURES[k].label, enabled: after[k] !== false });
    const out = wrapData({ enabled: on.map(state), disabled: off.map(state) });
    return { structured: out, text: JSON.stringify(out) };
  },
};

/** Kênh đã kết nối (Fanpage, Zalo OA, kênh đăng bài, thanh toán, trang bán hàng) + trạng thái + số liệu hôm nay — đúng khối "Kênh đã kết nối" ở Tổng quan. */
export const getConnectedChannelsTool: ToolDef = {
  name: 'get_connected_channels',
  title: 'Kênh đã kết nối / Connected channels',
  description:
    'Liệt kê các kênh đã kết nối với Trinity: Fanpage Facebook, Zalo OA, kênh đăng bài (Fanpage, YouTube), thanh toán (SePay, VNPay, MoMo), kết nối bán hàng, trang bán hàng. ' +
    'Mỗi kênh có trạng thái (ok = đang chạy, attention = cần kết nối lại hoặc có lỗi, off = đã tắt), một dòng ghi chú và số liệu hôm nay (tin nhắn mới, bài đã đăng, lượt thanh toán, đơn mới). ' +
    'available = tính năng đang bật nhưng chưa nối kênh nào. Chỉ thấy nhóm kênh hợp quyền của người dùng. Chỉ đọc. / Connected channels with status and today\'s counts. Read-only.',
  permissions: [],
  input: () => ({}),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(_args, { deps, principal }) {
    if (!deps.channels) throw new ToolUserError('Máy chủ chưa bật mục kênh kết nối. / Not available on this server.');
    const out = wrapData(await deps.channels.get(principal.user.grants));
    return { structured: out, text: JSON.stringify(out) };
  },
};
