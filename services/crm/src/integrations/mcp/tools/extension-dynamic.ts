import type { ExtensionsRuntime } from '../../../extensions/extensions.runtime';
import { wrapData } from '../ai-output';
import { ToolUserError, type ToolDef, type Z, type ZodShape } from './tool-types';

/** Tên tool động: `ext_<key>` (tool "run" duy nhất) hoặc `ext_<key>_<tool>` — tiền tố cố định nên không bao giờ đè tool lõi. */
export const mcpToolName = (key: string, tool: string): string => (tool === 'run' ? `ext_${key.replaceAll('-', '_')}` : `ext_${key.replaceAll('-', '_')}_${tool}`);

/** JSON Schema (object) → zod shape. Trường lạ không chuyển được ⇒ nhận mọi giá trị (người duyệt đã đọc schema; mã tool tự kiểm). */
export function shapeFromJsonSchema(z: Z, schema: Record<string, unknown>): ZodShape {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const shape: ZodShape = {};
  for (const [name, p] of Object.entries(props).slice(0, 30)) {
    let f: ReturnType<Z['unknown']>;
    try {
      f = (z as unknown as { fromJSONSchema(s: unknown): ReturnType<Z['unknown']> }).fromJSONSchema(p);
    } catch {
      f = z.unknown();
    }
    shape[name] = required.has(name) ? f : f.optional();
  }
  return shape;
}

/**
 * Tool động của các chương trình con loại `tool` đang `active`. Gọi chạy trong ext-host (Worker quyền riêng). Cần `extensions.view` + scope
 * crm.write. LƯU Ý: tool đọc/ghi dữ liệu bằng token của chính chương trình con (giới hạn bởi manifest.tables đã được người có quyền duyệt
 * xem), KHÔNG theo quyền/phạm vi dữ liệu của người gọi (và bị gỡ SĐT đầy đủ). Vì vậy `extensions.view` chỉ nên cấp cho vai trò tin cậy.
 * Hai khoá khác nhau có thể cho cùng một tên (`a`+`b` và `a-b`+`run` đều ra `ext_a_b`): giữ tool đầu tiên, bỏ tool trùng
 * để `registerTool` không ném lỗi làm hỏng MỌI request MCP.
 */
export function extensionToolDefs(rt: ExtensionsRuntime): ToolDef[] {
  const seen = new Set<string>();
  return rt.listActiveTools().flatMap(({ key, tools }) =>
    tools.filter((t) => {
      const name = mcpToolName(key, t.name);
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    }).map((t): ToolDef => ({
      name: mcpToolName(key, t.name),
      title: `${key} / ${t.name}`,
      description: `[Chương trình con ${key}] ${t.description || 'Công cụ do trợ lý AI viết và người đã duyệt.'}`,
      permissions: ['extensions.view'],
      scope: 'crm.write',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      input: (z) => shapeFromJsonSchema(z, t.inputSchema),
      output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
      async run(args) {
        const r = await rt.callTool(key, t.name, args);
        if (!r.ok) throw new ToolUserError(`Chương trình con "${key}" lỗi (${r.kind}): ${r.message}`.slice(0, 600));
        const o = wrapData({ result: r.value });
        return { structured: o, text: JSON.stringify(o) };
      },
    })),
  );
}
