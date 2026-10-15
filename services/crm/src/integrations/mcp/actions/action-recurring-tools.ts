import type { AuthUser } from '@trinity/rbac-nest';
import type { RecurrenceInput, RecurrenceRule, RecurrenceTemplate, RecurrenceView } from '../../../social/social-recurrence.service';
import { optInt } from '../tools/tool-types';
import { ActionUserError, type ActionDeps, type ActionToolDef, type DetailLine } from './action-types';
import { line, lines, shown } from './action-helpers';
import { VN_WEEKDAYS, assertPostConfirmed, captionsParam, mergeOptions, optionsFromCaption, postDetails, utmFromArgs, utmParams, vnWhen } from './action-social-tools';

type SocialSvc = NonNullable<ActionDeps['social']>;

async function social(deps: ActionDeps) {
  if (!deps.social) throw new ActionUserError('Máy chủ này chưa có tính năng đăng đa kênh. / Social posting is not available on this server.');
  if (!(await deps.orgFeatures.isEnabled('social_posting'))) throw new ActionUserError('Tính năng "Đăng đa kênh" đang tắt (Cài đặt › Tính năng). / Social posting is turned off.');
  return deps.social;
}

/** Lỗi tiếng Việt của service (400/404/409) → lỗi AI sửa được. */
const asUserError = (e: unknown): never => {
  const status = (e as { status?: number }).status;
  if (typeof status === 'number' && status < 500) throw new ActionUserError((e as Error).message);
  throw e;
};

/** "Hằng tuần, mỗi 2 tuần vào Thứ Hai, Thứ Năm lúc 09:00 (giờ Việt Nam)". */
export function describeRule(rule: RecurrenceRule): string {
  const n = rule.interval;
  const every = (unit: string, once: string) => (n > 1 ? `mỗi ${n} ${unit}` : once);
  const base =
    rule.freq === 'daily'
      ? `Hằng ngày${n > 1 ? `, ${every('ngày', '')}` : ''}`
      : rule.freq === 'weekly'
        ? `Hằng tuần${n > 1 ? `, ${every('tuần', '')}` : ''}${rule.weekdays?.length ? ` vào ${rule.weekdays.map((w) => VN_WEEKDAYS[w]).join(', ')}` : ''}`
        : `Hằng tháng${n > 1 ? `, ${every('tháng', '')}` : ''}${rule.month_day ? ` vào ngày ${rule.month_day}` : ''}`;
  return `${base} lúc ${rule.time} (giờ Việt Nam)`;
}

export const recurrenceStatus = (r: Pick<RecurrenceView, 'active' | 'next_run_at' | 'next_times'>): 'active' | 'paused' | 'finished' => (!r.active ? 'paused' : !r.next_run_at && r.next_times.length === 0 ? 'finished' : 'active');

const confirmParam = (z: Parameters<ActionToolDef['input']>[0]) =>
  z
    .string()
    .max(300)
    .optional()
    .describe(
      'Lời người dùng đồng ý, chép nguyên văn, sau khi họ xem nội dung, kênh, luật lặp và các lần đăng tới. Bài lặp lại sẽ tự đăng công khai nhiều lần nên bắt buộc; thiếu thì máy chủ không lưu gì và trả bản xem trước. / ' +
        "The user's own words approving the recurring post after seeing text, channels, rule and upcoming times, copied verbatim. Required; otherwise nothing is saved and a preview is returned.",
    );

const ruleParams = (z: Parameters<ActionToolDef['input']>[0]) => ({
  freq: z.enum(['daily', 'weekly', 'monthly']).optional().describe('Chu kỳ: daily = hằng ngày, weekly = hằng tuần, monthly = hằng tháng / Frequency'),
  interval: z.number().int().min(1).max(12).optional().describe('Mỗi N ngày/tuần/tháng (1–12, mặc định 1) / Every N days/weeks/months'),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional().describe('Chỉ weekly: các thứ đăng, 0 = Chủ nhật … 6 = Thứ bảy; bỏ trống = đúng thứ của starts_on / Weekly only: 0 = Sunday … 6'),
  month_day: z.number().int().min(1).max(31).optional().describe('Chỉ monthly: ngày trong tháng 1–31 (tháng ngắn lấy ngày cuối tháng) / Monthly only: day of month, clamped to the last day'),
  time: z.string().max(5).optional().describe('Giờ đăng HH:mm theo giờ Việt Nam, vd 09:00 / Time of day HH:mm in Vietnam time'),
});

const ruleFromArgs = (args: Record<string, unknown>): Partial<RecurrenceRule> => {
  const r: Partial<RecurrenceRule> = {};
  if (typeof args.freq === 'string') r.freq = args.freq as RecurrenceRule['freq'];
  const interval = optInt(args.interval);
  if (interval !== undefined) r.interval = interval;
  if (Array.isArray(args.weekdays)) r.weekdays = (args.weekdays as unknown[]).map(optInt).filter((x): x is number => x !== undefined);
  const md = optInt(args.month_day);
  if (md !== undefined) r.month_day = md;
  if (typeof args.time === 'string' && args.time.trim()) r.time = args.time.trim();
  return r;
};

const idsOf = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(optInt).filter((x): x is number => x !== undefined) : []);

/** Chi tiết cho người dùng duyệt: bài + luật lặp + 3 lần đăng tới (giờ Việt Nam). */
function recurringDetails(p: { title: string; rule: RecurrenceRule; startsOn: string; endsOn: string | null; maxCount: number | null; validated: Parameters<typeof postDetails>[0]; times: Date[] }): DetailLine[] {
  return [
    ...lines(
      line('Tên', p.title, 200),
      line('Lặp lại', describeRule(p.rule)),
      line('Bắt đầu', p.startsOn),
      line('Kết thúc', p.endsOn ? `đến hết ngày ${p.endsOn}` : p.maxCount ? `sau ${p.maxCount} lần đăng` : 'không kết thúc'),
      line('3 lần đăng tới', p.times.length ? p.times.map(vnWhen).join(' | ') : 'không còn lần nào'),
    ),
    ...postDetails({ ...p.validated, scheduledAt: null }).filter((d) => d.label !== 'Giờ đăng'),
  ];
}

export const createRecurringPostAction: ActionToolDef = {
  name: 'create_recurring_post',
  label: 'Tạo bài lặp lại',
  title: 'Tạo bài đăng lặp lại / Create recurring post',
  description:
    'Tạo lịch đăng lặp lại một bài ra các kênh đã liên kết (account_ids từ list_social_accounts): hằng ngày, hằng tuần (chọn thứ) hoặc hằng tháng (chọn ngày), giờ Việt Nam, kèm ngày bắt đầu và cách kết thúc (ends_on hoặc max_count, bỏ trống = không kết thúc). ' +
    'Trinity luôn giữ đúng một bài hẹn giờ sắp tới của lịch này; đến giờ bài lên công khai, rồi bài kế tiếp được tạo. Máy chủ tắt lâu quá 1 giờ thì bỏ lần lỡ, không đăng muộn. Xem và tạm dừng bằng list_recurring_posts / set_recurring_post_active. ' +
    'Bài tự đăng công khai nhiều lần nên cần confirmed_by_user sau khi người dùng xem nội dung, kênh, luật lặp và các lần đăng tới (bản xem trước nêu 3 lần đầu). Không có công cụ xoá; xoá lịch làm trên màn Đăng đa kênh › Lịch. / ' +
    'Creates a recurring multi-channel post: daily, weekly (choose weekdays) or monthly (choose day of month) in Vietnam time, with a start date and optional end (ends_on or max_count). Trinity always keeps exactly one upcoming scheduled post for the schedule; a run missed by more than an hour is skipped, not posted late. The post goes public repeatedly, so confirmed_by_user is required after the user has seen text, channels, rule and the next 3 times. There is no delete tool.',
  permissions: ['social.post'],
  destructive: false,
  idempotent: false,
  input: (z) => ({
    title: z.string().max(120).optional().describe('Tên gợi nhớ của lịch (bỏ trống = lấy đầu nội dung) / Short name'),
    content: z.string().max(63_206).optional().describe('Nội dung chung của bài (video YouTube có thể bỏ trống) / Post text'),
    account_ids: z.array(z.number().int().min(1).max(2_147_483_647)).min(1).max(20).describe('id các kênh người dùng đã nêu, từ list_social_accounts; không có kênh mặc định / Account ids the user named'),
    captions: captionsParam(z),
    media_keys: z.array(z.string().max(200)).max(10).optional().describe('media_key trong thư viện (list_social_media / upload_social_media) / Library media keys'),
    ...utmParams(z),
    ...ruleParams(z),
    starts_on: z.string().max(10).describe('Ngày bắt đầu YYYY-MM-DD theo giờ Việt Nam (lần đăng đầu là lần đầu tiên khớp luật từ ngày này, sau bây giờ) / Start date YYYY-MM-DD, Vietnam time'),
    ends_on: z.string().max(10).optional().describe('Ngày kết thúc YYYY-MM-DD (tính cả ngày đó); bỏ trống = không kết thúc / End date, inclusive'),
    max_count: z.number().int().min(1).max(1000).optional().describe('Dừng sau N bài; bỏ trống = không giới hạn / Stop after N posts'),
    confirmed_by_user: confirmParam(z),
  }),
  async prepare(args, { deps, user }) {
    const s = await social(deps);
    const ids = idsOf(args.account_ids);
    const caps = new Map<number, string>();
    const opts = new Map<number, Record<string, unknown>>();
    for (const c of Array.isArray(args.captions) ? (args.captions as Array<Record<string, unknown>>) : []) {
      const id = optInt(c.account_id);
      if (!id) continue;
      if (!ids.includes(id)) throw new ActionUserError(`captions có account_id ${id} không nằm trong account_ids.`);
      if (typeof c.caption === 'string' && c.caption.trim()) caps.set(id, c.caption.trim());
      const o = optionsFromCaption(c);
      if (Object.keys(o).length) opts.set(id, o);
    }
    const content = typeof args.content === 'string' ? args.content : '';
    const utm = utmFromArgs(args);
    const template: RecurrenceTemplate = {
      content,
      media_keys: Array.isArray(args.media_keys) ? (args.media_keys as unknown[]).filter((k): k is string => typeof k === 'string') : [],
      targets: ids.map((account_id) => ({ account_id, caption: caps.get(account_id) ?? null, options: opts.get(account_id) ?? {} })),
      ...(utm ? { utm } : {}),
    };
    const title = (typeof args.title === 'string' && args.title.trim() ? args.title.trim() : content.trim().replace(/\s+/g, ' ').slice(0, 60)) || 'Bài lặp lại';
    const input: RecurrenceInput = {
      title,
      template,
      rule: ruleFromArgs(args),
      starts_on: typeof args.starts_on === 'string' ? args.starts_on.trim() : undefined,
      ends_on: typeof args.ends_on === 'string' && args.ends_on.trim() ? args.ends_on.trim() : null,
      max_count: optInt(args.max_count) ?? null,
    };
    const p = await s.recurrences.preview(user, input).catch(asUserError);
    const details = recurringDetails(p);
    assertPostConfirmed(args.confirmed_by_user, details);
    return { params: { input }, summary: shown(`Đăng lặp lại "${p.title}": ${describeRule(p.rule)}, ${p.validated.targets.length} kênh`), details };
  },
  async execute(params, { deps, user }) {
    const s = await social(deps);
    const r = await s.recurrences.create(user, (params as { input: RecurrenceInput }).input).catch(asUserError);
    return { recurrence_id: r.id, title: r.title, status: r.active ? 'active' : 'paused', rule: describeRule(r.rule), next_times: r.next_times.map((t) => vnWhen(new Date(t))), upcoming_post_id: r.posts.find((p) => p.status === 'scheduled')?.id ?? null, ...(r.last_error ? { error: r.last_error } : {}) };
  },
};

type RecurPatch = { title?: string; content?: string; account_ids?: number[]; captions?: Array<Record<string, unknown>>; media_keys?: string[]; utm?: { campaign: string; content?: string } | null; rule?: Partial<RecurrenceRule>; starts_on?: string; ends_on?: string | null; max_count?: number | null };

/** Phần sửa + lịch HIỆN TẠI ⇒ đầu vào đầy đủ cho `recurrences.update` (trường không sửa giữ như đang có). */
async function resolveUpdate(s: SocialSvc, user: AuthUser, id: number, patch: RecurPatch) {
  const cur = await s.recurrences.get(id).catch(asUserError);
  const ids = patch.account_ids ?? cur.template.targets.map((t) => t.account_id);
  const caps = new Map<number, Record<string, unknown>>();
  for (const c of patch.captions ?? []) {
    const aid = optInt(c.account_id);
    if (!aid) continue;
    if (!ids.includes(aid)) throw new ActionUserError(`captions có account_id ${aid} không nằm trong danh sách kênh của lịch.`);
    caps.set(aid, c);
  }
  const template: RecurrenceTemplate = {
    content: patch.content ?? cur.template.content,
    media_keys: patch.media_keys ?? cur.template.media_keys,
    targets: ids.map((account_id) => {
      const old = cur.template.targets.find((t) => t.account_id === account_id);
      const c = caps.get(account_id);
      const caption = c && typeof c.caption === 'string' ? c.caption.trim() || null : (old?.caption ?? null);
      return { account_id, caption, options: mergeOptions((old?.options ?? {}) as Record<string, unknown>, c) };
    }),
    ...(patch.utm === undefined ? (cur.template.utm ? { utm: cur.template.utm } : {}) : patch.utm ? { utm: patch.utm } : {}),
  };
  const input: RecurrenceInput = {
    title: patch.title ?? cur.title,
    template,
    rule: patch.rule ?? {},
    ...(patch.starts_on !== undefined ? { starts_on: patch.starts_on } : {}),
    ...(patch.ends_on !== undefined ? { ends_on: patch.ends_on } : {}),
    ...(patch.max_count !== undefined ? { max_count: patch.max_count } : {}),
  };
  const p = await s.recurrences.preview(user, input, id).catch(asUserError);
  return { input, p };
}

export const updateRecurringPostAction: ActionToolDef = {
  name: 'update_recurring_post',
  label: 'Sửa bài lặp lại',
  title: 'Sửa bài đăng lặp lại / Update recurring post',
  description:
    'Sửa một lịch đăng lặp lại (recurrence_id từ list_recurring_posts): nội dung, kênh, tệp, UTM, luật lặp (freq, interval, weekdays, month_day, time), ngày bắt đầu/kết thúc, số lần. Trường nào bỏ trống thì giữ như cũ. Chỉ áp cho các bài SAU: bài hẹn giờ đang chờ của lịch bị huỷ (không xoá) và tạo lại theo bản mới; bài đã đăng giữ nguyên. ends_on "" = bỏ ngày kết thúc; max_count 0 = bỏ giới hạn số lần; utm_campaign "" = bỏ UTM. ' +
    'Bài sẽ lên công khai nên cần confirmed_by_user sau khi người dùng xem bản sửa và các lần đăng tới. / ' +
    'Edits a recurring schedule; omitted fields keep their value. Applies to future posts only: the pending scheduled post is cancelled (not deleted) and re-created; published posts stay. ends_on "" removes the end date, max_count 0 removes the limit. Requires confirmed_by_user.',
  permissions: ['social.post'],
  destructive: false,
  idempotent: false,
  input: (z) => ({
    recurrence_id: z.number().int().min(1).max(2_147_483_647).describe('id lịch lặp (list_recurring_posts) / Recurrence id'),
    title: z.string().max(120).optional().describe('Tên mới / New name'),
    content: z.string().max(63_206).optional().describe('Nội dung chung mới; bỏ trống = giữ / New text'),
    account_ids: z.array(z.number().int().min(1).max(2_147_483_647)).min(1).max(20).optional().describe('Danh sách kênh mới (thay toàn bộ); bỏ trống = giữ / New channel list'),
    captions: captionsParam(z),
    media_keys: z.array(z.string().max(200)).max(10).optional().describe('Danh sách tệp mới (thay toàn bộ); bỏ trống = giữ / New media list'),
    ...utmParams(z),
    ...ruleParams(z),
    starts_on: z.string().max(10).optional().describe('Ngày bắt đầu mới YYYY-MM-DD / New start date'),
    ends_on: z.string().max(10).optional().describe('Ngày kết thúc mới YYYY-MM-DD; "" = bỏ / New end date; "" removes'),
    max_count: z.number().int().min(0).max(1000).optional().describe('Dừng sau N bài; 0 = bỏ giới hạn / Stop after N posts; 0 removes'),
    confirmed_by_user: confirmParam(z),
  }),
  async prepare(args, { deps, user }) {
    const s = await social(deps);
    const id = optInt(args.recurrence_id);
    if (!id) throw new ActionUserError('recurrence_id không hợp lệ.');
    // Chỉ lưu PHẦN SỬA: chế độ duyệt có thể chờ tới 24 giờ, lịch sửa trên giao diện trong lúc đó không bị ghi đè.
    const rule = ruleFromArgs(args);
    const patch: RecurPatch = {
      title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined,
      content: typeof args.content === 'string' ? args.content : undefined,
      account_ids: Array.isArray(args.account_ids) ? idsOf(args.account_ids) : undefined,
      captions: Array.isArray(args.captions) ? (args.captions as Array<Record<string, unknown>>) : undefined,
      media_keys: Array.isArray(args.media_keys) ? (args.media_keys as unknown[]).filter((k): k is string => typeof k === 'string') : undefined,
      utm: utmFromArgs(args),
      rule: Object.keys(rule).length ? rule : undefined,
      starts_on: typeof args.starts_on === 'string' && args.starts_on.trim() ? args.starts_on.trim() : undefined,
      ends_on: typeof args.ends_on === 'string' ? args.ends_on.trim() || null : undefined,
      max_count: typeof args.max_count === 'number' ? optInt(args.max_count) || null : undefined,
    };
    const { p } = await resolveUpdate(s, user, id, patch);
    const details = recurringDetails(p);
    assertPostConfirmed(args.confirmed_by_user, details);
    return { params: { recurrence_id: id, patch }, summary: shown(`Sửa bài lặp lại #${id} "${p.title}"`), details };
  },
  async execute(params, { deps, user }) {
    const s = await social(deps);
    const { recurrence_id, patch } = params as { recurrence_id: number; patch: RecurPatch };
    // Ghép phần sửa với lịch HIỆN TẠI (không phải lúc chuẩn bị) rồi kiểm lại.
    const { input } = await resolveUpdate(s, user, Number(recurrence_id), patch ?? {});
    const r = await s.recurrences.update(user, Number(recurrence_id), input).catch(asUserError);
    return { recurrence_id: r.id, title: r.title, status: r.active ? 'active' : 'paused', rule: describeRule(r.rule), next_times: r.next_times.map((t) => vnWhen(new Date(t))), ...(r.last_error ? { error: r.last_error } : {}) };
  },
};

export const setRecurringPostActiveAction: ActionToolDef = {
  name: 'set_recurring_post_active',
  label: 'Tạm dừng / tiếp tục bài lặp lại',
  title: 'Tạm dừng hoặc tiếp tục bài lặp lại / Pause or resume recurring post',
  description:
    'active=false: tạm dừng lịch lặp (huỷ bài hẹn giờ đang chờ, không xoá gì), làm ngay không cần xác nhận. active=true: tiếp tục — tính lại lần đăng kế tiếp từ bây giờ (lần lỡ trong lúc dừng không đăng bù), bài sẽ lên công khai nên cần confirmed_by_user sau khi người dùng xem các lần đăng tới. Dùng recurrence_id từ list_recurring_posts; lịch bị tạm dừng vì lỗi (last_error) thì sửa nguyên nhân (update_recurring_post hoặc liên kết lại kênh) rồi tiếp tục. Không có công cụ xoá lịch. / ' +
    'active=false pauses the schedule (cancels the pending scheduled post, deletes nothing) with no confirmation. active=true resumes it: the next run is recomputed from now and missed runs are not posted late; it requires confirmed_by_user after the user sees the upcoming times. No delete tool.',
  permissions: ['social.post'],
  destructive: false,
  idempotent: true,
  input: (z) => ({
    recurrence_id: z.number().int().min(1).max(2_147_483_647).describe('id lịch lặp / Recurrence id'),
    active: z.boolean().describe('false = tạm dừng; true = tiếp tục / false pauses, true resumes'),
    confirmed_by_user: confirmParam(z),
  }),
  async prepare(args, { deps, user }) {
    const s = await social(deps);
    const id = optInt(args.recurrence_id);
    if (!id) throw new ActionUserError('recurrence_id không hợp lệ.');
    if (typeof args.active !== 'boolean') throw new ActionUserError('Thiếu active (true = tiếp tục, false = tạm dừng).');
    const cur = await s.recurrences.get(id).catch(asUserError);
    if (!args.active) return { params: { recurrence_id: id, active: false }, summary: shown(`Tạm dừng bài lặp lại #${id} "${cur.title}"`), details: lines(line('Lặp lại', describeRule(cur.rule)), line('Bài hẹn đang chờ', cur.posts.some((p) => p.status === 'scheduled') ? 'sẽ bị huỷ (không xoá)' : 'không có')) };
    const p = await s.recurrences.preview(user, {}, id).catch(asUserError);
    const details = recurringDetails(p);
    assertPostConfirmed(args.confirmed_by_user, details);
    return { params: { recurrence_id: id, active: true }, summary: shown(`Tiếp tục bài lặp lại #${id} "${cur.title}"`), details };
  },
  async execute(params, { deps }) {
    const s = await social(deps);
    const id = Number(params.recurrence_id);
    const r = await (params.active ? s.recurrences.resume(id) : s.recurrences.pause(id)).catch(asUserError);
    return { recurrence_id: r.id, status: r.active ? 'active' : 'paused', next_times: r.next_times.map((t) => vnWhen(new Date(t))), ...(r.last_error ? { error: r.last_error } : {}) };
  },
};
