import { buildConnectPrompt, CONNECT_AGENTS, isConnectAgent } from './connect-prompts';

const URL = 'https://crm.example.com/api/v1/mcp';

describe('buildConnectPrompt', () => {
  it('mọi agent: địa chỉ thật của hệ thống, chỉ OAuth (không xin token), bước get_setup_guide, không còn {URL}', () => {
    for (const { key } of CONNECT_AGENTS) {
      const p = buildConnectPrompt(key, URL);
      expect(p).toContain(URL);
      expect(p).not.toContain('{URL}');
      expect(p).toMatch(/OAuth 2\.1/);
      expect(p).toMatch(/401 kèm WWW-Authenticate là BÌNH THƯỜNG/);
      expect(p).toMatch(/KHÔNG hỏi mình token/);
      expect(p).toContain('get_setup_guide');
      expect(p).not.toMatch(/phanmemtrinity|aiilab/);
    }
  });

  it('Claude Code: lệnh claude mcp add http + đăng nhập /mcp + skill', () => {
    const p = buildConnectPrompt('claude_code', URL);
    expect(p).toContain(`claude mcp add --transport http --scope user trinity ${URL}`);
    expect(p).toContain('/mcp');
    expect(p).toContain('~/.claude/skills/trinity/SKILL.md');
  });

  it('Antigravity: file ~/.gemini/config/mcp_config.json với serverUrl, nút Authenticate, không dùng .agents/plugins làm cấu hình', () => {
    const p = buildConnectPrompt('antigravity', URL);
    expect(p).toContain('~/.gemini/config/mcp_config.json');
    expect(p).toContain(`"serverUrl": "${URL}"`);
    expect(p).toContain('Authenticate');
    expect(p).toContain('KHÔNG dùng thư mục .agents/plugins');
    expect(p).toContain('mcp-remote');
    expect(p).toContain('~/.gemini/GEMINI.md');
    expect(p).not.toContain('rules/trinity.md');
  });

  it('cú pháp đúng từng agent', () => {
    expect(buildConnectPrompt('gemini_cli', URL)).toContain(`"httpUrl": "${URL}"`);
    expect(buildConnectPrompt('cursor', URL)).toContain(`"url": "${URL}"`);
    expect(buildConnectPrompt('codex', URL)).toContain(`codex mcp add trinity --url ${URL}`);
    expect(buildConnectPrompt('vscode', URL)).toContain(`"type": "http", "url": "${URL}"`);
  });

  it('agent web (ChatGPT, Claude): hướng dẫn bấm trên web, không bảo tạo file, không mcp-remote', () => {
    for (const k of ['chatgpt', 'claude'] as const) {
      const p = buildConnectPrompt(k, URL);
      expect(p).not.toContain('mcp-remote');
      expect(p).not.toContain('TRINITY-KET-NOI.md');
      expect(p).toContain('Ghi nhớ khi làm việc với Trinity');
    }
  });

  it('isConnectAgent', () => {
    expect(isConnectAgent('antigravity')).toBe(true);
    expect(isConnectAgent('x')).toBe(false);
  });
});
