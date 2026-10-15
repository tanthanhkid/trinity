// Mã TIN CẬY chạy đầu mỗi Worker (một Worker = một chương trình con loại tool). Quyền của Worker do host khai khi tạo
// (`deno.permissions`) — file này chỉ nạp mã khách (import() động từ data: URL, xem job-main.ts) rồi trả lời lời gọi.
import { type Gateway, makeCtx } from './ctx.ts'
import { dataUrl, metaOf, resolveTools, type ToolDef } from './module.ts'

type InMsg =
  | { type: 'init'; code: string; gateway?: Gateway; inputSchema?: Record<string, unknown>; description?: string }
  | { type: 'call'; id: number; tool: string; args: unknown }

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null
  postMessage(m: unknown): void
}
let tools: Record<string, ToolDef> = {}
let ctx = makeCtx(null)

const errInfo = (e: unknown) => ({
  name: e instanceof Error ? e.name : 'Error',
  message: e instanceof Error ? e.message : String(e),
})

async function init(m: Extract<InMsg, { type: 'init' }>): Promise<void> {
  try {
    const mod = (await import(dataUrl(m.code))) as Record<string, unknown>
    tools = resolveTools(mod, m.inputSchema, m.description)
    ctx = makeCtx(null, m.gateway)
    scope.postMessage({ type: 'ready', tools: metaOf(tools) })
  } catch (e) {
    scope.postMessage({ type: 'init_error', error: errInfo(e) })
  }
}

async function call(m: Extract<InMsg, { type: 'call' }>): Promise<void> {
  const tool = tools[m.tool]
  if (!tool)
    return scope.postMessage({
      type: 'result',
      id: m.id,
      ok: false,
      error: { name: 'UnknownTool', message: m.tool },
    })
  try {
    scope.postMessage({
      type: 'result',
      id: m.id,
      ok: true,
      value: (await tool.run(m.args, ctx)) ?? null,
    })
  } catch (e) {
    scope.postMessage({ type: 'result', id: m.id, ok: false, error: errInfo(e) })
  }
}

scope.onmessage = (e) => void (e.data.type === 'init' ? init(e.data) : call(e.data))
