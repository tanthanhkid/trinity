/**
 * Prompt "nối Trinity" theo từng agent: người dùng chọn agent mình dùng ở bước 1 onboarding, bấm Copy, dán MỘT lần là
 * agent tự gắn đúng máy chủ (đúng file/lệnh của chính agent đó), đăng nhập bằng OAuth, tạo rule/skill "trinity" cho
 * mình, rồi bắt đầu dựng CRM. Dùng chung cho `GET /setup/connect-prompt` (màn onboarding) và tool get_setup_guide.
 *
 * Chữ "MCP" được phép trong prompt (agent cần biết); giao diện người dùng thì không hiện chữ này.
 */

export const CONNECT_AGENTS = [
  { key: 'chatgpt', label: 'ChatGPT', kind: 'web' },
  { key: 'claude', label: 'Claude (web / Desktop)', kind: 'web' },
  { key: 'claude_code', label: 'Claude Code', kind: 'cli' },
  { key: 'antigravity', label: 'Antigravity', kind: 'cli' },
  { key: 'gemini_cli', label: 'Gemini CLI', kind: 'cli' },
  { key: 'cursor', label: 'Cursor', kind: 'cli' },
  { key: 'codex', label: 'Codex CLI', kind: 'cli' },
  { key: 'vscode', label: 'VS Code Copilot', kind: 'cli' },
  { key: 'other', label: 'Agent khác', kind: 'cli' },
] as const

export type ConnectAgent = (typeof CONNECT_AGENTS)[number]['key']

export function isConnectAgent(x: unknown): x is ConnectAgent {
  return typeof x === 'string' && CONNECT_AGENTS.some((a) => a.key === x)
}

/** Nội dung rule/skill "trinity" agent tự tạo cho mình sau khi nối (ngắn, đúng luật dùng Trinity). */
export const TRINITY_RULE = [
  '# Trinity CRM',
  'Trinity là CRM của công ty, nối qua MCP server "trinity". Khi người dùng nhắc tới khách hàng, đơn, việc, báo cáo, Fanpage, Zalo, đăng bài… thì dùng các tool của Trinity.',
  '- Đầu mỗi phiên làm việc với Trinity: gọi get_setup_guide trước và làm theo "next" trong kết quả.',
  '- Gặp mã như KH001, CV001, HS001: tra bằng find_by_code.',
  '- Trinity không có tool xoá. Muốn bỏ thứ gì thì báo người dùng làm trên giao diện Trinity.',
  '- Đăng bài công khai, gửi tin hàng loạt, tắt tính năng: cho người dùng xem trước và chỉ làm khi họ đồng ý (confirmed_by_user là lời đồng ý của họ, chép nguyên văn).',
  '- Trả lời người dùng bằng ngôn ngữ của họ (mặc định tiếng Việt).',
].join('\n')

interface AgentSetup {
  /** Cách gắn máy chủ vào agent (lệnh / file / thao tác trên web). */
  connect: string
  /** Nơi tạo rule/skill "trinity" (null = agent web, không tạo file). */
  rule: string | null
}

/** Cú pháp từng agent — kiểm theo tài liệu chính thức (xem PR). `{URL}` thay bằng địa chỉ thật. */
const SETUPS: Record<ConnectAgent, AgentSetup> = {
  chatgpt: {
    connect: [
      'ChatGPT nối máy chủ trên web, không cần file. Hướng dẫn mình bấm (menu có thể đổi tên theo phiên bản):',
      '1. ChatGPT › Settings › Apps (hoặc Plugins / Apps & Connectors). Nếu có mục Advanced thì bật Developer mode.',
      '2. Chọn Create / Add custom MCP server: tên "Trinity", URL {URL}, xác thực OAuth.',
      '3. Bấm Connect, đăng nhập Trinity và bấm Cho phép.',
      '4. Mở cuộc trò chuyện mới, bật Trinity trong danh sách công cụ.',
      'Gói Business/Enterprise dùng đầy đủ; trên gói Business có thể cần quản trị viên tạo kết nối.',
    ].join('\n'),
    rule: null,
  },
  claude: {
    connect: [
      'Claude nối máy chủ trên web hoặc Claude Desktop, không cần file. Hướng dẫn mình bấm:',
      '1. Gói Pro/Max: Customize › Connectors › + Add › Add custom connector. Gói Team/Enterprise: chủ tổ chức thêm ở Organization settings › Connectors › Add › Custom › Web, rồi từng người bấm Connect ở Customize › Connectors.',
      '2. Tên "Trinity", URL {URL}. Phần OAuth để mặc định (Register automatically).',
      '3. Bấm Connect, đăng nhập Trinity và bấm Cho phép.',
      '4. Trong cuộc trò chuyện, bật Trinity ở menu công cụ.',
    ].join('\n'),
    rule: null,
  },
  claude_code: {
    connect: [
      'Chạy trong terminal:',
      '```',
      'claude mcp add --transport http --scope user trinity {URL}',
      '```',
      'Rồi trong phiên Claude Code gõ /mcp, chọn trinity › Authenticate (hoặc chạy `claude mcp login trinity`). Trình duyệt mở trang đăng nhập Trinity.',
      'Kiểm: `claude mcp list` thấy trinity ở trạng thái connected.',
    ].join('\n'),
    rule: 'Tạo skill tại ~/.claude/skills/trinity/SKILL.md (frontmatter: name: trinity, description: Dùng Trinity CRM qua MCP server trinity — khách hàng, việc, đơn, báo cáo, Fanpage, Zalo). Thân skill là nội dung dưới đây:',
  },
  antigravity: {
    connect: [
      'Antigravity đọc máy chủ từ file cấu hình chung ~/.gemini/config/mcp_config.json (hoặc .agents/mcp_config.json trong workspace). KHÔNG dùng thư mục .agents/plugins. Thêm (giữ các server đang có):',
      '```json',
      '{ "mcpServers": { "trinity": { "serverUrl": "{URL}" } } }',
      '```',
      'Rồi mở Settings › Customizations, bấm Authenticate cạnh trinity, đăng nhập Trinity, bấm Cho phép; nếu trình duyệt hiện mã thì dán mã đó lại vào Antigravity.',
    ].join('\n'),
    rule: 'Tạo rule tại ~/.gemini/config/rules/trinity.md (hoặc .agents/rules/trinity.md nếu chỉ dùng cho workspace này) với nội dung:',
  },
  gemini_cli: {
    connect: [
      'Gemini CLI (bản mới đã chuyển thành Antigravity CLI; nếu bạn là Antigravity thì làm theo cách của Antigravity). Thêm vào ~/.gemini/settings.json (giữ cấu hình đang có):',
      '```json',
      '{ "mcpServers": { "trinity": { "httpUrl": "{URL}" } } }',
      '```',
      'Khởi động lại Gemini CLI, gõ `/mcp auth trinity` để đăng nhập (cần trình duyệt trên máy). Kiểm bằng `/mcp`.',
    ].join('\n'),
    rule: 'Thêm vào ~/.gemini/GEMINI.md (tạo nếu chưa có) mục sau:',
  },
  cursor: {
    connect: [
      'Thêm vào ~/.cursor/mcp.json (dùng cho mọi dự án) hoặc .cursor/mcp.json (chỉ dự án này), giữ các server đang có:',
      '```json',
      '{ "mcpServers": { "trinity": { "url": "{URL}" } } }',
      '```',
      'Mở Cursor Settings › MCP, bấm Login/Connect cạnh trinity để đăng nhập Trinity.',
    ].join('\n'),
    rule: 'Tạo rule .cursor/rules/trinity.mdc (frontmatter: description: Dùng Trinity CRM qua MCP server trinity; alwaysApply: false) với thân là nội dung:',
  },
  codex: {
    connect: [
      'Chạy trong terminal:',
      '```',
      'codex mcp add trinity --url {URL}',
      'codex mcp login trinity',
      '```',
      'Hoặc thêm tay vào ~/.codex/config.toml:',
      '```toml',
      '[mcp_servers.trinity]',
      'url = "{URL}"',
      '```',
      'rồi chạy `codex mcp login trinity`. Kiểm bằng `codex mcp list`.',
    ].join('\n'),
    rule: 'Thêm vào AGENTS.md (ở thư mục đang làm việc, hoặc ~/.codex/AGENTS.md cho mọi dự án) mục sau:',
  },
  vscode: {
    connect: [
      'Thêm vào .vscode/mcp.json của workspace (hoặc cấu hình MCP của người dùng qua lệnh "MCP: Open User Configuration"), giữ các server đang có:',
      '```json',
      '{ "servers": { "trinity": { "type": "http", "url": "{URL}" } } }',
      '```',
      'Bấm Start cạnh trinity trong file; cửa sổ đăng nhập Trinity mở ra. Nếu VS Code đòi clientId thì dùng cách dự phòng mcp-remote bên dưới.',
    ].join('\n'),
    rule: 'Tạo file .github/instructions/trinity.instructions.md (hoặc thêm vào .github/copilot-instructions.md) với nội dung:',
  },
  other: {
    connect: [
      'Gắn máy chủ theo cách của chính bạn (agent). Đọc tài liệu của bạn về "remote MCP server / Streamable HTTP":',
      '- Nếu bạn hỗ trợ máy chủ HTTP có OAuth: khai URL {URL} (thường là khoá "url", "httpUrl" hoặc "serverUrl" trong file cấu hình MCP của bạn), rồi dùng nút/lệnh đăng nhập của bạn.',
      '- Nếu bạn chỉ hỗ trợ máy chủ stdio: dùng cầu nối mcp-remote bên dưới.',
    ].join('\n'),
    rule: 'Nếu bạn có cơ chế rule/skill/memory (vd AGENTS.md, GEMINI.md, CLAUDE.md, thư mục rules), tạo một mục "trinity" với nội dung:',
  },
}

const label = (agent: ConnectAgent) => CONNECT_AGENTS.find((a) => a.key === agent)?.label ?? agent

/** Prompt đầy đủ ngữ cảnh cho agent `agent`, với địa chỉ máy chủ của chính hệ thống này. */
export function buildConnectPrompt(agent: ConnectAgent, mcpUrl: string): string {
  const s = SETUPS[agent];
  const web = CONNECT_AGENTS.find((a) => a.key === agent)?.kind === 'web';
  const fill = (t: string) => t.split('{URL}').join(mcpUrl);
  const parts = [
    `Giúp mình nối ${label(agent)} với Trinity, phần mềm quản lý khách hàng (CRM) của công ty mình. Trinity mã nguồn mở, điều khiển bằng trợ lý AI: bạn đọc và ghi dữ liệu Trinity qua các tool của nó, theo đúng quyền của tài khoản mình.`,
    '',
    '## Máy chủ',
    `- Địa chỉ MCP (Streamable HTTP): ${mcpUrl}`,
    '- Tên server nên đặt: trinity',
    '',
    '## Đăng nhập',
    '- Trinity chỉ dùng OAuth 2.1 (tự đăng ký client: DCR hoặc CIMD, có PKCE). Không có token tĩnh hay API key cho việc này.',
    '- Gọi thử mà nhận 401 kèm WWW-Authenticate là BÌNH THƯỜNG: đó là tín hiệu để client mở trang đăng nhập Trinity.',
    '- KHÔNG hỏi mình token, KHÔNG bảo mình dán Bearer token, KHÔNG dùng curl để lấy token, KHÔNG tự tạo file plugin trong thư mục dự án.',
    '- Khi trang đăng nhập Trinity mở ra: mình đăng nhập, giữ ô "Cho phép AI thay đổi dữ liệu" rồi bấm Cho phép.',
    '',
    `## Cách gắn vào ${label(agent)}`,
    fill(s.connect),
  ];
  if (!web) {
    parts.push(
      '',
      '## Nếu không đăng nhập được',
      `Nếu ${label(agent)} không tự mở trang đăng nhập (không có nút Authenticate/Login cho server), thay cấu hình trên bằng cầu nối chạy cục bộ, cầu nối này tự làm OAuth trong trình duyệt:`,
      '```',
      `npx -y mcp-remote ${mcpUrl}`,
      '```',
      'Khai nó như một server stdio: command "npx", args ["-y", "mcp-remote", "' + mcpUrl + '"].',
    );
  }
  if (s.rule) {
    parts.push(
      '',
      '## Sau khi nối xong: tạo rule cho chính bạn',
      fill(s.rule),
      '```markdown',
      TRINITY_RULE,
      '```',
      '',
      'Rồi tạo thêm một file ghi chú ngắn cho mình tên TRINITY-KET-NOI.md ở thư mục đang làm việc: đã nối server nào, địa chỉ, cách gọi lại Trinity (vd "hỏi Trinity hôm nay có gì mới"), cách đăng nhập lại nếu hết phiên.',
    );
  } else {
    parts.push('', '## Ghi nhớ khi làm việc với Trinity', TRINITY_RULE);
  }
  parts.push(
    '',
    '## Bước đầu tiên khi đã thấy tool của Trinity',
    'Gọi get_setup_guide và làm theo kết quả:',
    '- status = chua_dung (CRM còn trống): phỏng vấn mình TỪNG câu một theo kịch bản trong kết quả, tóm tắt cho mình xác nhận, rồi propose_workspace → import_records (nếu mình có file) → complete_setup.',
    '- status = dang_dung: giúp mình nhập dữ liệu rồi complete_setup.',
    '- status = da_dung: hỏi mình muốn làm gì hôm nay.',
    '',
    'Trả lời mình bằng tiếng Việt (hoặc ngôn ngữ mình đang dùng). Báo ngắn từng bước bạn làm.',
  );
  return parts.join('\n');
}
