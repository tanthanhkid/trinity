import { BadRequestException, NotFoundException } from '@nestjs/common';
import { wrapData } from '../ai-output';
import { vnWhen } from '../actions/action-social-tools';
import { isUserConfirmation } from '../actions/user-confirmation';
import { broadcastForAi, broadcastsDeps, STATUS_VI } from './facebook-broadcast-tools';
import { socialDeps } from './social-tools';
import { ToolUserError, optInt, type ToolDef } from './tool-types';

/**
 * Huỷ việc CHƯA chạy: bài đang hẹn giờ, lượt gửi hàng loạt đang chờ. Chỉ đổi trạng thái sang "đã huỷ" — không xoá dữ liệu,
 * không gỡ gì đã lên mạng. Hai bước (xem trước → `confirmed_by_user`).
 */
const CONFIRM_DESC =
  'Lời người dùng đồng ý huỷ, chép nguyên văn, sau khi xem bản xem trước. Bỏ trống ở lần gọi đầu. / The user approval verbatim; omit on the first call.';

function toolError(err: unknown): never {
  if (err instanceof BadRequestException || err instanceof NotFoundException) throw new ToolUserError(err.message);
  throw err;
}

export const cancelScheduledPostTool: ToolDef = {
  name: 'cancel_scheduled_post',
  title: 'Huỷ bài đăng đang hẹn giờ / Cancel a scheduled post',
  description:
    'Huỷ một bài đăng đa kênh ĐANG HẸN GIỜ (status scheduled, chưa kênh nào đăng; post_id từ list_social_posts): bài chuyển sang "đã huỷ", sẽ không đăng nữa. Bài vẫn còn trong Trinity (không xoá). ' +
    'Bài đã đăng hoặc đang đăng thì không huỷ được ở đây. Muốn đổi giờ thay vì huỷ thì dùng reschedule_social_post. ' +
    'Bước 1: gọi KHÔNG có confirmed_by_user ⇒ không huỷ gì, trả bản xem trước (nội dung, giờ hẹn, kênh). Bước 2: người dùng đồng ý thì gọi lại kèm confirmed_by_user nguyên văn. Cần scope crm.write. / ' +
    'Cancels a scheduled social post that has not been published on any channel; the post is kept with status cancelled. Call once without confirmed_by_user for a preview, then again with the user approval verbatim.',
  permissions: ['social.post'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: (z) => ({
    post_id: z.number().int().min(1).max(2_147_483_647).describe('id bài / Post id'),
    confirmed_by_user: z.string().max(300).optional().describe(CONFIRM_DESC),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps }) {
    const s = await socialDeps(deps);
    const id = optInt(args.post_id);
    if (!id) throw new ToolUserError('post_id không hợp lệ. / Invalid post_id.');
    try {
      const p = await s.posts.get(id);
      if (p.status !== 'scheduled' || p.targets.some((t) => t.status !== 'queued' && t.status !== 'cancelled')) {
        throw new ToolUserError(`Bài #${id} đang ở trạng thái "${p.status}" — chỉ huỷ được bài đang hẹn giờ, chưa kênh nào đăng. / Only scheduled, unpublished posts can be cancelled.`);
      }
      const preview = {
        post_id: id,
        content: p.content,
        scheduled_at: p.scheduled_at ? vnWhen(p.scheduled_at) : null,
        channels: p.targets.filter((t) => t.status === 'queued').map((t) => t.account_name ?? `#${t.account_id}`),
      };
      if (!isUserConfirmation(args.confirmed_by_user)) {
        const out = wrapData({ cancelled: false, preview, next_step: 'CHƯA HUỶ. Đưa người dùng xem bài sẽ huỷ; người dùng đồng ý thì gọi lại với confirmed_by_user.' });
        return { structured: out, text: JSON.stringify(out) };
      }
      const after = await s.posts.cancel(id);
      // Tới giờ đúng lúc huỷ: kênh đã bắt đầu đăng thì không huỷ được — báo thật thay vì báo huỷ hết.
      const started = after.targets.filter((t) => t.status !== 'cancelled').map((t) => ({ account: t.account_name ?? `#${t.account_id}`, status: t.status }));
      const out = wrapData({
        cancelled: started.length === 0,
        post_id: id,
        status: after.status,
        channels: preview.channels,
        already_started: started.length ? started : undefined,
        note: started.length ? 'Bài vừa tới giờ đăng — các kênh trong already_started đã bắt đầu đăng nên không huỷ được; gỡ bài đã đăng ở màn Đăng đa kênh của Trinity.' : undefined,
      });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      toolError(err);
    }
  },
};

export const cancelMessengerBroadcastTool: ToolDef = {
  name: 'cancel_messenger_broadcast',
  title: 'Huỷ lượt gửi tin hàng loạt chưa chạy / Cancel a pending Messenger broadcast',
  description:
    'Huỷ một lượt gửi tin hàng loạt Messenger đang CHỜ tới giờ gửi (status scheduled; broadcast_id từ list_messenger_broadcasts): lượt chuyển sang "đã huỷ", không ai nhận tin. Lượt vẫn còn trong Trinity (không xoá). ' +
    'Lượt đang gửi, đã xong hoặc còn là nháp thì không huỷ ở đây (nháp chưa gửi thì không cần huỷ). ' +
    'Bước 1: gọi KHÔNG có confirmed_by_user ⇒ không huỷ gì, trả bản xem trước. Bước 2: người dùng đồng ý thì gọi lại kèm confirmed_by_user nguyên văn. Cần scope crm.write. / ' +
    'Cancels a Messenger broadcast that is waiting for its send time; it is kept with status cancelled. Call once without confirmed_by_user for a preview, then again with the user approval verbatim.',
  permissions: ['integrations.webhooks'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: (z) => ({
    broadcast_id: z.number().int().min(1).max(2_147_483_647).describe('broadcast_id từ list_messenger_broadcasts / Broadcast id'),
    confirmed_by_user: z.string().max(300).optional().describe(CONFIRM_DESC),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl }) {
    const svc = await broadcastsDeps(deps);
    try {
      const b = await svc.get(Number(args.broadcast_id));
      if (b.status !== 'scheduled') {
        throw new ToolUserError(`Lượt này ${STATUS_VI[b.status] ?? b.status} — chỉ huỷ được lượt đang chờ tới giờ gửi. / Only broadcasts waiting for their send time can be cancelled.`);
      }
      if (!isUserConfirmation(args.confirmed_by_user)) {
        const out = wrapData({ cancelled: false, preview: broadcastForAi(b, baseUrl), next_step: 'CHƯA HUỶ. Đưa người dùng xem lượt gửi sẽ huỷ; người dùng đồng ý thì gọi lại với confirmed_by_user.' });
        return { structured: out, text: JSON.stringify(out) };
      }
      const after = await svc.cancelPending(b.id);
      const out = wrapData({ cancelled: true, ...broadcastForAi(after, baseUrl) });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      toolError(err);
    }
  },
};

export const CANCEL_TOOLS: readonly ToolDef[] = [cancelScheduledPostTool, cancelMessengerBroadcastTool];
