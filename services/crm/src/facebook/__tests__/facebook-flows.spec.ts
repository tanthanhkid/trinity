import { BadRequestException } from '@nestjs/common';
import { buttonPayload, cleanSteps, FacebookFlowsService, nextAfter, parseButtonPayload, type FlowStep } from '../facebook-flows.service';
import { GraphApiError } from '../graph-client';

describe('kịch bản — hàm thuần', () => {
  it('cleanSteps: gán mã s1.., cắt khoảng trắng, bỏ wait 0', () => {
    const s = cleanSteps([{ text: ' Chào {ten} ', wait_minutes: 0 }, { text: 'Bước 2', wait_minutes: 30 }]);
    expect(s).toEqual([{ id: 's1', text: 'Chào {ten}' }, { id: 's2', text: 'Bước 2', wait_minutes: 30 }]);
  });

  it('cleanSteps: nút trỏ bước có thật; trùng mã / bước lạ / nút dài / hỏi kèm nút / chờ quá 23h ⇒ lỗi', () => {
    expect(() => cleanSteps([])).toThrow(BadRequestException);
    expect(() => cleanSteps([{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }])).toThrow(/trùng/);
    expect(() => cleanSteps([{ text: 'x', buttons: [{ title: 'Có', next: 'zz' }] }])).toThrow(/không có trong kịch bản/);
    expect(() => cleanSteps([{ text: 'x', buttons: [{ title: 'Một nút có chữ quá dài nhé', next: null }] }])).toThrow(/20 ký tự/);
    expect(() => cleanSteps([{ text: 'x', ask: 'phone', buttons: [{ title: 'A', next: null }] }])).toThrow(/tách/);
    expect(() => cleanSteps([{ text: 'x', wait_minutes: 24 * 60 }])).toThrow(/23 giờ/);
    expect(() => cleanSteps([{ text: '' }])).toThrow(/nội dung/);
  });

  it('cleanSteps: vòng toàn bước tự gửi ⇒ lỗi; vòng qua bước có nút thì được (menu)', () => {
    expect(() => cleanSteps([{ id: 'a', text: 'x', next: 'b' }, { id: 'b', text: 'y', next: 'a' }])).toThrow(/vòng/);
    expect(cleanSteps([{ id: 'menu', text: 'Chọn', buttons: [{ title: 'Giá', next: 'gia' }] }, { id: 'gia', text: '500k', next: 'menu' }])).toHaveLength(2);
  });

  it('nextAfter: next rõ > bước kế > hết', () => {
    const steps: FlowStep[] = [{ id: 'a', text: '1' }, { id: 'b', text: '2', next: null }, { id: 'c', text: '3', next: 'a' }];
    expect(nextAfter(steps, steps[0])).toBe('b');
    expect(nextAfter(steps, steps[1])).toBeNull();
    expect(nextAfter(steps, steps[2])).toBe('a');
  });

  it('payload nút đi một vòng; payload lạ ⇒ null', () => {
    expect(parseButtonPayload(buttonPayload(12, 's3', 1))).toEqual({ runId: 12, stepId: 's3', index: 1 });
    expect(parseButtonPayload('GET_STARTED')).toBeNull();
    expect(parseButtonPayload('FLOW:x:s1:0')).toBeNull();
    expect(parseButtonPayload(undefined)).toBeNull();
  });
});

/** DB giả trong bộ nhớ — đủ cho các truy vấn FacebookFlowsService dùng. */
function fakeDb() {
  const now = Date.now();
  const db = {
    flows: [] as Array<Record<string, any>>,
    runs: [] as Array<Record<string, any>>,
    messages: [] as Array<Record<string, any>>,
    convs: [{ id: 1, page_id: 'P', psid: 'U', customer_name: 'Lan', contact_id: 9, last_inbound_at: new Date(now - 60_000) }] as Array<Record<string, any>>,
    links: [{ id: 4, code: 'qrcode12', page_id: 'P', is_active: true }],
    contact: { id: 9, phone: '', phone_2: null as string | null, email: null as string | null },
    activities: [] as Array<Record<string, any>>,
  };
  const match = (row: Record<string, any>, where: Record<string, any> = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return v.in.includes(row[k]);
        if ('gte' in v) return row[k] >= v.gte;
        if ('lte' in v) return row[k] !== null && row[k] <= v.lte;
      }
      return row[k] === v;
    });
  let runId = 0;
  const prisma: any = {
    facebookFlow: {
      findFirst: async ({ where }: any) => db.flows.filter((f) => match(f, where)).sort((a, b) => b.id - a.id)[0] ?? null,
      findMany: async ({ where }: any = {}) => db.flows.filter((f) => match(f, where)).sort((a, b) => b.id - a.id),
      findUnique: async ({ where }: any) => db.flows.find((f) => f.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const f = db.flows.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries<any>(data)) f[k] = v && typeof v === 'object' && 'increment' in v ? f[k] + v.increment : v;
        return f;
      },
    },
    facebookFlowRun: {
      findFirst: async ({ where }: any) => db.runs.filter((r) => match(r, where)).sort((a, b) => b.id - a.id)[0] ?? null,
      findMany: async ({ where }: any) => db.runs.filter((r) => match(r, where)),
      findUnique: async ({ where }: any) => db.runs.find((r) => r.id === where.id) ?? null,
      count: async ({ where }: any) => db.runs.filter((r) => match(r, where)).length,
      create: async ({ data }: any) => {
        const r = { id: ++runId, started_at: new Date(), due_at: null, note: null, ...data };
        db.runs.push(r);
        return r;
      },
      update: async ({ where, data }: any) => Object.assign(db.runs.find((r) => r.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        const rows = db.runs.filter((r) => match(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
    facebookConversation: {
      findUnique: async ({ where }: any) =>
        db.convs.find((c) => (where.id ? c.id === where.id : c.page_id === where.page_id_psid.page_id && c.psid === where.page_id_psid.psid)) ?? null,
      update: async ({ where, data }: any) => Object.assign(db.convs.find((c) => c.id === where.id)!, data),
    },
    facebookMessage: {
      count: async ({ where }: any) => db.messages.filter((m) => match(m, where)).length,
      create: async ({ data }: any) => (db.messages.push(data), data),
    },
    facebookChatLink: { findUnique: async ({ where }: any) => db.links.find((l) => l.code === where.code) ?? null },
    contact: {
      findUnique: async () => db.contact,
      update: async ({ data }: any) => Object.assign(db.contact, data),
      updateMany: async ({ data }: any) => (db.contact.email ? { count: 0 } : (Object.assign(db.contact, data), { count: 1 })),
    },
    activity: { create: async ({ data }: any) => (db.activities.push(data), data) },
    $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
  };
  return { db, prisma };
}

function mk() {
  const { db, prisma } = fakeDb();
  let mid = 0;
  const graph = {
    sendText: jest.fn(async () => ({ message_id: `m${++mid}` })),
    sendQuickReplies: jest.fn(async () => ({ message_id: `m${++mid}` })),
  };
  const pages = { activePageWithToken: jest.fn(async () => ({ token: 'T', page: {} })), markTokenInvalid: jest.fn() };
  const svc = new FacebookFlowsService(prisma, graph as never, pages as never);
  const addFlow = (f: Record<string, any>) => {
    const row = { id: db.flows.length + 1, page_id: 'P', is_active: true, keywords: [], chat_link_id: null, starts: 0, completes: 0, name: 'KB', ...f };
    db.flows.push(row);
    return row;
  };
  const inbound = (text: string, extra: Record<string, any> = {}) => {
    db.messages.push({ conversation_id: 1, direction: 'in', text });
    db.convs[0].last_inbound_at = new Date();
    return { sender: { id: 'U' }, recipient: { id: 'P' }, message: { mid: `in${db.messages.length}`, text, ...extra } };
  };
  return { db, svc, graph, pages, addFlow, inbound };
}

describe('FacebookFlowsService — chạy kịch bản', () => {
  it('từ khoá ⇒ gửi bước 1 ({ten}), dừng ở bước có nút; bấm nút ⇒ đi nhánh và kết thúc (đếm completes)', async () => {
    const { db, svc, graph, addFlow, inbound } = mk();
    const flow = addFlow({
      trigger: 'keyword',
      keywords: ['học phí'],
      steps: [
        { id: 's1', text: 'Chào {ten}!' },
        { id: 's2', text: 'Bạn quan tâm khoá nào?', buttons: [{ title: 'Trẻ em', next: 'kid' }, { title: 'Người lớn', next: null }] },
        { id: 'kid', text: 'Khoá trẻ em 500k/tháng', next: null },
      ],
    });
    expect(await svc.handleEvent('P', inbound('cho hỏi HOC PHI'), true)).toBe(true);
    expect(graph.sendText).toHaveBeenCalledWith('T', 'U', 'Chào Lan!');
    expect(graph.sendQuickReplies).toHaveBeenCalledWith('T', 'U', 'Bạn quan tâm khoá nào?', [
      { title: 'Trẻ em', payload: buttonPayload(1, 's2', 0) },
      { title: 'Người lớn', payload: buttonPayload(1, 's2', 1) },
    ]);
    expect(db.runs[0]).toMatchObject({ status: 'waiting_button', step_id: 's2' });
    expect(db.messages.filter((m) => m.direction === 'out')).toHaveLength(2);

    // Khách gõ chữ thường khi đang chờ nút ⇒ không làm gì (nhân viên xử lý)
    expect(await svc.handleEvent('P', inbound('ok'), true)).toBe(false);
    // Bấm nút
    expect(await svc.handleEvent('P', inbound('Trẻ em', { quick_reply: { payload: buttonPayload(1, 's2', 0) } }), true)).toBe(true);
    expect(graph.sendText).toHaveBeenLastCalledWith('T', 'U', 'Khoá trẻ em 500k/tháng');
    expect(db.runs[0]).toMatchObject({ status: 'done', step_id: null });
    expect(flow.completes).toBe(1);
    expect(flow.starts).toBe(1);
    // Bấm lại nút cũ (Meta gửi lại / bấm 2 lần) ⇒ bỏ qua
    expect(await svc.handleEvent('P', inbound('Trẻ em', { quick_reply: { payload: buttonPayload(1, 's2', 0) } }), true)).toBe(false);
  });

  it('hỏi SĐT: sai thì hỏi lại một lần, đúng thì lưu vào khách và đi tiếp', async () => {
    const { db, svc, graph, addFlow, inbound } = mk();
    addFlow({ trigger: 'keyword', keywords: ['tư vấn'], steps: [{ id: 'q', text: 'Cho mình xin SĐT nhé', ask: 'phone' }, { id: 'ok', text: 'Cảm ơn, tư vấn viên sẽ gọi bạn' }] });
    await svc.handleEvent('P', inbound('tu van'), true);
    expect(db.runs[0].status).toBe('waiting_answer');
    await svc.handleEvent('P', inbound('mai nhé'), true);
    expect(graph.sendText).toHaveBeenLastCalledWith('T', 'U', expect.stringContaining('chưa nhận ra số'));
    expect(db.runs[0]).toMatchObject({ status: 'waiting_answer', note: 'retry' });
    await svc.handleEvent('P', inbound('0912 345 678'), true);
    expect(db.contact.phone).toBe('0912345678');
    expect(graph.sendText).toHaveBeenLastCalledWith('T', 'U', 'Cảm ơn, tư vấn viên sẽ gọi bạn');
    expect(db.runs[0].status).toBe('done');
    expect(db.activities.some((a) => a.details.description.includes('0912345678'))).toBe(true);
  });

  it('bước có chờ ⇒ đặt lịch; job tới giờ gửi; quá 24h ⇒ expired, không gửi', async () => {
    const { db, svc, graph, addFlow, inbound } = mk();
    addFlow({ trigger: 'keyword', keywords: ['giá'], steps: [{ id: 'a', text: 'Gửi bạn bảng giá' }, { id: 'b', text: 'Bạn xem bảng giá chưa?', wait_minutes: 60 }] });
    await svc.handleEvent('P', inbound('giá bao nhiêu'), true);
    expect(db.runs[0]).toMatchObject({ status: 'scheduled', step_id: 'b' });
    expect(graph.sendText).toHaveBeenCalledTimes(1);
    expect((await svc.runDue(1000)).processed).toBe(0); // chưa tới giờ
    db.runs[0].due_at = new Date(Date.now() - 1000);
    expect((await svc.runDue(1000)).processed).toBe(1);
    expect(graph.sendText).toHaveBeenLastCalledWith('T', 'U', 'Bạn xem bảng giá chưa?');
    expect(db.runs[0].status).toBe('done');

    // Lượt thứ hai: khách im quá 24h ⇒ không gửi
    db.runs.length = 0;
    await svc.handleEvent('P', inbound('giá'), true);
    db.runs[0].due_at = new Date(Date.now() - 1000);
    db.convs[0].last_inbound_at = new Date(Date.now() - 25 * 3600_000);
    const sent = graph.sendText.mock.calls.length;
    await svc.runDue(1000);
    expect(graph.sendText.mock.calls.length).toBe(sent);
    expect(db.runs[0].status).toBe('expired');
  });

  it('kickIfDue (không có timer): bước tới giờ ⇒ chạy nền và gửi; chưa tới giờ ⇒ không làm gì', async () => {
    const { db, svc, graph, addFlow, inbound } = mk();
    addFlow({ trigger: 'keyword', keywords: ['giá'], steps: [{ id: 'a', text: 'Bảng giá' }, { id: 'b', text: 'Nhắc lại', wait_minutes: 60 }] });
    await svc.handleEvent('P', inbound('giá'), true);
    expect(await svc.kickIfDue()).toEqual({ due: false });
    db.runs[0].due_at = new Date(Date.now() - 1000);
    expect(await svc.kickIfDue()).toEqual({ due: false }); // kiểm DB tối đa mỗi 20 giây
    expect(await svc.kickIfDue(Date.now() + 25_000)).toEqual({ due: true });
    for (let i = 0; i < 20 && db.runs[0].status !== 'done'; i++) await new Promise((r) => setImmediate(r));
    expect(graph.sendText).toHaveBeenLastCalledWith('T', 'U', 'Nhắc lại');
  });

  it('link/QR có kịch bản ⇒ chạy khi khách vào qua link; Meta gửi lại trong 10 phút không chạy lần hai', async () => {
    const { db, svc, graph, addFlow } = mk();
    addFlow({ trigger: 'chat_link', chat_link_id: 4, steps: [{ id: 'a', text: 'Chào bạn đến từ tờ rơi' }] });
    const ev = { sender: { id: 'U' }, referral: { ref: 'qrcode12' } };
    expect(await svc.handleEvent('P', ev, false)).toBe(true);
    expect(await svc.handleEvent('P', ev, false)).toBe(false);
    expect(graph.sendText).toHaveBeenCalledTimes(1);
    expect(db.runs).toHaveLength(1);
  });

  it('tin đầu tiên của khách mới ⇒ kịch bản chào; tin thứ hai không chạy lại; kịch bản tắt ⇒ không chạy', async () => {
    const { svc, graph, addFlow, inbound } = mk();
    const welcome = addFlow({ trigger: 'first_message', steps: [{ id: 'a', text: 'Xin chào!' }], is_active: false });
    expect(await svc.handleEvent('P', inbound('hi'), true)).toBe(false);
    welcome.is_active = true;
    const { svc: svc2, graph: g2, addFlow: add2, inbound: in2 } = mk();
    add2({ trigger: 'first_message', steps: [{ id: 'a', text: 'Xin chào!' }] });
    expect(await svc2.handleEvent('P', in2('hi'), true)).toBe(true);
    expect(await svc2.handleEvent('P', in2('alo'), true)).toBe(false);
    expect(g2.sendText).toHaveBeenCalledTimes(1);
    expect(graph.sendText).not.toHaveBeenCalled();
  });

  it('Meta gửi lại tin cũ (isNewMessage=false) ⇒ không xử lý; tin echo ⇒ bỏ qua', async () => {
    const { svc, graph, addFlow, inbound } = mk();
    addFlow({ trigger: 'keyword', keywords: ['giá'], steps: [{ id: 'a', text: 'x' }] });
    expect(await svc.handleEvent('P', inbound('giá'), false)).toBe(false);
    expect(await svc.handleEvent('P', { sender: { id: 'P' }, recipient: { id: 'U' }, message: { mid: 'e', text: 'giá', is_echo: true } }, true)).toBe(false);
    expect(graph.sendText).not.toHaveBeenCalled();
  });

  it('Facebook báo ngoài 24h khi gửi ⇒ expired; lỗi token ⇒ failed + đánh dấu token hỏng', async () => {
    const { db, svc, graph, pages, addFlow, inbound } = mk();
    addFlow({ trigger: 'keyword', keywords: ['a'], steps: [{ id: 'a', text: 'x' }] });
    graph.sendText.mockRejectedValueOnce(Object.assign(new GraphApiError(400, 10, 2018278, 'outside'), {}));
    await svc.handleEvent('P', inbound('a'), true);
    expect(db.runs[0].status).toBe('expired');
    db.runs.length = 0;
    graph.sendText.mockRejectedValueOnce(new GraphApiError(400, 190, null, 'token'));
    await svc.handleEvent('P', inbound('a'), true);
    expect(db.runs[0].status).toBe('failed');
    expect(pages.markTokenInvalid).toHaveBeenCalledWith('P');
  });
});
