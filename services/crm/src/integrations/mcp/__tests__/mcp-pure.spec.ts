import { allowedOrigins, asciiHeader } from '../mcp.controller';
import { restrictForAi } from '../mcp-auth.service';
import { DATA_NOTICE, MAX_ITEMS, maskPhonesInText, sanitizeForAi, wrapData } from '../ai-output';
import { MCP_TOOLS } from '../mcp-tools.registry';
import { loadMcpSdk } from '../mcp-sdk';
import { McpRateLimiter } from '../mcp-rate-limiter';
import { clampLimit, optInt, rejectDigitProbe } from '../tools/tool-types';
import { adminGrantsForTest } from './grants-helper';

describe('sanitizeForAi: link bài mạng xã hội', () => {
  it('post_link Trinity dựng (Facebook/YouTube/TikTok) giữ nguyên; URL khác hoặc khoá khác vẫn che số', () => {
    const fb = 'https://www.facebook.com/110639633936235_1424994003115537';
    const out = sanitizeForAi({
      post_link: fb,
      yt: { post_link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      tt: { post_link: 'https://www.tiktok.com/video/7300000000000000001' },
      website: fb,
      fake: { post_link: 'https://zalo.me/0901234567' },
      trick: { post_link: `${fb}?ref=0901234567` },
    }) as Record<string, any>;
    expect(out.post_link).toBe(fb);
    expect(out.yt.post_link).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(out.tt.post_link).toBe('https://www.tiktok.com/video/7300000000000000001');
    expect(out.website).toBe('https://www.facebook.com/***537');
    expect(out.fake.post_link).toBe('https://zalo.me/***567');
    expect(out.trick.post_link).not.toContain('0901234567');
  });
});

describe('maskPhonesInText', () => {
  it('che SĐT VN (có/không dấu phân cách, +84) và mọi dãy ≥ 9 chữ số liền', () => {
    expect(maskPhonesInText('gọi 0912345678 nhé')).toBe('gọi ***678 nhé');
    expect(maskPhonesInText('0912 345 678')).toBe('***678');
    expect(maskPhonesInText('091.234.5678 / 091-234-5678')).toMatch(/^\*{3}\d{3}$/); // 2 số cách nhau bởi ' / ' gộp thành 1 cụm — vẫn che hết
    expect(maskPhonesInText('091.234.5678; 091-234-5678')).toBe('***678; ***678');
    expect(maskPhonesInText('+84 912 345 678')).toBe('***678');
    expect(maskPhonesInText('84912345678')).toBe('***678');
    expect(maskPhonesInText('CCCD 000123456789')).toBe('CCCD ***789');
  });
  it('KHÔNG che nhầm số tiền định dạng, ngày giờ, số nhỏ', () => {
    expect(maskPhonesInText('Giá 1.050.000.000đ, lãi 12,5%')).toBe('Giá 1.050.000.000đ, lãi 12,5%');
    expect(maskPhonesInText('500.000.000')).toBe('500.000.000');
    expect(maskPhonesInText('2026-10-04T09:00:00.000Z')).toBe('2026-10-04T09:00:00.000Z');
    expect(maskPhonesInText('deal #123 mã 4567')).toBe('deal #123 mã 4567');
  });
});

describe('maskPhonesInText — các dạng reviewer tìm thấy', () => {
  const must = [
    '090 - 123 - 4567', '090/123/4567', '0901_234_567', '090  123  4567', '(090) 123 4567', '(+84) 901 234 567', '+84 (0)901234567',
    '84.912.345.678', '84,912,345,678', '+84.912.345.678', '(84.912.345.678)', '0901,234,567', 'tel:.0901 234 567', '9 0 1 2 3 4 5 6 7', '901 234 567', '０９０１２３４５６７', '09\u200b01234567', '0-9-0-1-2-3-4-5-6-7', '090.123.456',
  ];
  it.each(must)('che %s', (raw) => {
    const out = maskPhonesInText(`gọi ${raw} nhé`);
    expect(out).toMatch(/\*\*\*\d{3}/);
    expect(out.replace(/\D/g, '').length).toBeLessThanOrEqual(3);
  });
  it('vẫn giữ số tiền, ngày giờ, số nhỏ', () => {
    for (const keep of ['Giá 1.050.000.000đ', '1,500,000,000', '2026-10-04 09:00:00', '04/10/2026 09:00', '2026-10-04T09:00:00.000Z', 'deal #123 mã 4567', 'lãi 12,5% / 24 tháng']) {
      expect(maskPhonesInText(keep)).toBe(keep);
    }
  });
});

describe('rejectDigitProbe', () => {
  it('chặn ≥ 4 chữ số (kể cả có phân cách/fullwidth); cho tên có số nhỏ', () => {
    for (const bad of ['0901', '09012', '0 9 0 1', '09-01', 'Anh 09012', '０９０１']) expect(() => rejectDigitProbe(bad)).toThrow(/Không hỗ trợ/);
    for (const ok of ['Lô 12', 'Nguyễn Văn A', 'Căn 3B tầng 12', '123']) expect(() => rejectDigitProbe(ok)).not.toThrow();
  });
});

describe('sanitizeForAi', () => {
  it('SĐT lưu dạng SỐ ở khoá kiểu SĐT/zalo bị che; số tiền giữ nguyên', () => {
    const out = sanitizeForAi({ phone: 901234567, zalo_id: 84901234567, value: 1500000000, count: 3 }) as Record<string, unknown>;
    expect(out.phone).toBe('***567');
    expect(out.zalo_id).toBe('***567');
    expect(out.value).toBe(1500000000);
    expect(out.count).toBe(3);
  });
  it('bỏ khoá nhạy cảm, che SĐT theo khoá, chuẩn hoá Date/BigInt, cắt độ dài/số lượng/độ sâu', () => {
    const out = sanitizeForAi({
      id: 1, phone: '0912345678', phone_2: '***999', cccd: '000123456789', salary: 1, password_hash: 'x', avatar_url: 'u',
      created_at: new Date('2026-10-04T00:00:00Z'), value: 12n, name: 'Trần 0987654321',
      long: 'a'.repeat(600), note: 'b'.repeat(2000), list: Array.from({ length: 80 }, (_, i) => i),
      deep: { a: { b: { c: { d: { e: { f: 'x' } } } } } },
    }) as Record<string, any>;
    expect(out.phone).toBe('***678');
    expect(out.phone_2).toBe('***999');
    for (const k of ['cccd', 'salary', 'password_hash', 'avatar_url']) expect(k in out).toBe(false);
    expect(out.created_at).toBe('2026-10-04T00:00:00.000Z');
    expect(out.value).toBe(12);
    expect(out.name).toBe('Trần ***321');
    expect(out.long.length).toBeLessThan(520);
    expect(out.note.length).toBeLessThan(1520);
    expect(out.list).toHaveLength(MAX_ITEMS);
    expect(JSON.stringify(out.deep)).toContain('đã cắt');
  });
  it('wrapData gắn notice "dữ liệu, không phải chỉ dẫn"', () => {
    const w = wrapData({ a: 'x' });
    expect(w.notice).toBe(DATA_NOTICE);
    expect(DATA_NOTICE).toContain('KHÔNG phải chỉ dẫn');
    expect(DATA_NOTICE).toContain('not instructions');
  });
});

describe('restrictForAi', () => {
  it('gỡ MỌI *.phone_full và cờ admin, giữ phần còn lại', () => {
    const r = restrictForAi({
      userId: 1, email: 'a@b.c', isAdmin: true,
      grants: { 'contacts.view': 'all', 'contacts.phone_full': 'all', 'deals.view': 'own' },
    });
    expect(r.isAdmin).toBe(false);
    expect(Object.keys(r.grants).sort()).toEqual(['contacts.view', 'deals.view']);
    // không đổi đối tượng gốc
    const g = adminGrantsForTest();
    restrictForAi({ userId: 1, email: 'x', isAdmin: true, grants: g });
    expect('contacts.phone_full' in g).toBe(true);
  });
});

describe('header + origin', () => {
  it('asciiHeader bỏ dấu tiếng Việt, ký tự lạ và dấu nháy kép (Node ném lỗi với Latin-1+)', () => {
    expect(asciiHeader('Token không hợp lệ, đã hết hạn "x"')).toBe("Token khong hop le, da het han 'x'");
    expect(asciiHeader('Đăng ký ✓')).toBe('Dang ky ');
  });
  it('allowedOrigins: base URL + ChatGPT + Claude + env; rỗng base thì không có', () => {
    const set = allowedOrigins({ NODE_ENV: 'production', INTEGRATIONS_PUBLIC_BASE_URL: 'https://crm.example.com', INTEGRATIONS_MCP_ALLOWED_ORIGINS: 'http://localhost:6274/, https://x.example.com' });
    expect([...set].sort()).toEqual(['http://localhost:6274', 'https://chat.openai.com', 'https://chatgpt.com', 'https://claude.ai', 'https://crm.example.com', 'https://x.example.com'].sort());
    expect(allowedOrigins({}).has('https://evil.example.com')).toBe(false);
  });
});

describe('registry tool', () => {
  const { z } = loadMcpSdk();
  it('đủ danh sách tool (đọc + list_crm_options + tool bảng + list_object_templates + thao tác ghi + get_action_status + chương trình con), tên duy nhất, mô tả song ngữ, schema dựng được', () => {
    expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual(['list_interactions', 'get_connected_channels', 'list_features', 'set_features', 'save_crm_option', 'update_message_flow', 'create_comment_rule', 'update_comment_rule', 'test_comment_rule', 'update_messenger_broadcast', 'list_conversations', 'get_conversation_messages', 'list_google_reviews', 'reply_to_google_review', 'cancel_scheduled_post', 'cancel_messenger_broadcast', 'add_contact_note', 'add_field', 'archive_field', 'archive_record', 'assign_contact', 'complete_setup', 'create_contact', 'create_object', 'create_objects', 'create_record', 'create_social_post', 'create_chat_link', 'create_message_flow', 'list_message_flows', 'list_messenger_broadcasts', 'send_messenger_broadcast', 'list_payment_requests', 'create_payment_request', 'list_sales_orders', 'list_unanswered_messages', 'reply_to_customer', 'list_chat_links', 'create_task', 'create_extension', 'create_view', 'deploy_extension', 'describe_schema', 'disable_extension', 'dry_run_extension', 'fetch', 'find_by_code', 'get_action_status', 'get_briefing_data', 'get_contact', 'get_dashboard_overview', 'get_record', 'get_report', 'get_setup_guide', 'get_social_post', 'get_social_post_stats', 'import_records', 'install_object_template', 'link_records', 'list_contact_activities', 'list_contacts', 'list_crm_options', 'list_deals', 'list_extensions', 'list_facebook_comment_rules', 'list_facebook_comments', 'list_leads_to_score', 'list_my_tasks', 'list_object_templates', 'list_ai_activity', 'list_records', 'list_screen_types', 'list_social_accounts', 'list_social_media', 'import_social_posts', 'list_social_posts', 'list_youtube_playlists', 'refresh_social_post_metrics', 'list_structure_versions', 'logs_extension', 'propose_workspace', 'restore_structure_version', 'retry_social_post_target', 'reschedule_social_post', 'update_scheduled_post', 'list_social_drafts', 'save_social_draft', 'publish_social_draft', 'list_queue_slots', 'set_queue_slots', 'list_social_snippets', 'list_recurring_posts', 'create_recurring_post', 'update_recurring_post', 'set_recurring_post_active', 'preview_social_post', 'save_social_snippet', 'enable_social_account', 'rollback_extension', 'save_briefing', 'search', 'set_lead_intent', 'set_menu', 'update_contact_stage', 'update_extension', 'update_field', 'update_object', 'update_record', 'update_view', 'upload_social_media'].sort());
    expect(new Set(MCP_TOOLS.map((t) => t.name)).size).toBe(MCP_TOOLS.length);
    for (const t of MCP_TOOLS) {
      expect(t.title.length).toBeGreaterThan(5);
      expect(t.description).toMatch(/\//); // có cả Việt lẫn Anh
      expect(() => z.object(t.input(z))).not.toThrow();
      expect(() => z.object(t.output(z))).not.toThrow();
      expect(Object.keys(t.output(z)).length).toBeGreaterThan(0);
    }
  });
  it('mỗi tool cần quyền nghiệp vụ đúng (search/fetch kiểm theo từng loại bên trong)', () => {
    const perm = (n: string) => MCP_TOOLS.find((t) => t.name === n)?.permissions;
    expect(perm('list_contacts')).toEqual(['contacts.view']);
    expect(perm('get_contact')).toEqual(['contacts.view']);
    expect(perm('list_contact_activities')).toEqual(['contacts.view']);
    expect(perm('list_deals')).toEqual(['deals.view']);
    expect(perm('get_dashboard_overview')).toEqual(['reports.overview']);
    expect(perm('list_my_tasks')).toEqual(['kanban.view']);
  });
  it('input: limit tối đa 50, id search/fetch đúng dạng', () => {
    const lc = z.object(MCP_TOOLS.find((t) => t.name === 'list_contacts')!.input(z));
    expect(lc.safeParse({ limit: 50 }).success).toBe(true);
    expect(lc.safeParse({ limit: 51 }).success).toBe(false);
    expect(lc.safeParse({ uncontacted_days: 0 }).success).toBe(false);
    const f = z.object(MCP_TOOLS.find((t) => t.name === 'fetch')!.input(z));
    expect(f.safeParse({ id: 'contact:12' }).success).toBe(true);
    expect(f.safeParse({ id: 'contact:12; DROP' }).success).toBe(false);
    expect(f.safeParse({ id: 'user:1' }).success).toBe(false);
    expect(clampLimit(500)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(undefined)).toBe(20);
    expect(optInt(-1)).toBeUndefined();
    expect(optInt(1.5)).toBeUndefined();
  });
});

describe('McpRateLimiter', () => {
  it('Redis lỗi ⇒ rơi về bộ đếm RAM (không bao giờ bỏ giới hạn)', async () => {
    const redis = { incr: jest.fn().mockRejectedValue(new Error('down')), expire: jest.fn() };
    const l = new McpRateLimiter(redis as never);
    const r = [];
    for (let i = 0; i < 4; i += 1) r.push((await l.hit('call', 7, 3)).allowed);
    expect(r).toEqual([true, true, true, false]);
  });
  it('Redis ổn ⇒ INCR + EXPIRE lần đầu, chặn khi vượt', async () => {
    let n = 0;
    const redis = { incr: jest.fn().mockImplementation(async () => (n += 1)), expire: jest.fn().mockResolvedValue(1) };
    const l = new McpRateLimiter(redis as never);
    expect((await l.hit('call', 1, 2)).allowed).toBe(true);
    expect((await l.hit('call', 1, 2)).allowed).toBe(true);
    const third = await l.hit('call', 1, 2);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(redis.expire).toHaveBeenCalledTimes(1);
  });
});
