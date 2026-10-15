import type { McpServer as McpServerType } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport as TransportType } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { z as ZType } from 'zod';

export interface McpSdk {
  McpServer: typeof McpServerType;
  StreamableHTTPServerTransport: typeof TransportType;
  z: typeof ZType;
}

let cached: McpSdk | null = null;

/**
 * Nạp SDK MCP + zod LƯỜI (lần gọi MCP đầu tiên) — tiết kiệm RAM trên máy nhỏ: khi cờ MCP tắt (mặc định) thư viện này KHÔNG
 * được nạp vào heap. Dùng `require` (CJS build của SDK, `exports['./*'].require`) thay vì `import()` để TypeScript
 * (module commonjs) không biến thành `Promise` và không kéo nó vào đồ thị import lúc khởi động.
 */
export function loadMcpSdk(): McpSdk {
  if (cached) return cached;
  /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
  cached = {
    McpServer: (require('@modelcontextprotocol/sdk/server/mcp.js') as { McpServer: typeof McpServerType }).McpServer,
    StreamableHTTPServerTransport: (require('@modelcontextprotocol/sdk/server/streamableHttp.js') as { StreamableHTTPServerTransport: typeof TransportType })
      .StreamableHTTPServerTransport,
    z: (require('zod') as { z: typeof ZType }).z,
  };
  /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
  return cached;
}
