// Chuẩn hoá mã khách thành bảng tool. Hai dạng hợp lệ:
//   export default async function (args, ctx) { … }            → MỘT tool tên "run", schema lấy từ manifest.input_schema
//   export const tools = { ten: { description, inputSchema, run(args, ctx) } }   → nhiều tool
import type { ExtCtx } from "./ctx.ts";

export interface ToolDef {
  description?: string;
  inputSchema?: Record<string, unknown>;
  run: (args: unknown, ctx: ExtCtx) => unknown;
}

export interface ToolMeta {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function dataUrl(code: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(code)) bin += String.fromCharCode(b);
  return `data:text/typescript;base64,${btoa(bin)}`;
}

export function resolveTools(mod: Record<string, unknown>, inputSchema?: Record<string, unknown>, description?: string): Record<string, ToolDef> {
  if (mod.tools && typeof mod.tools === "object") return mod.tools as Record<string, ToolDef>;
  if (typeof mod.default === "function") {
    const fn = mod.default as ToolDef["run"];
    return { run: { description, inputSchema, run: fn } };
  }
  throw new Error("mã chương trình con phải `export default` một hàm hoặc `export const tools`");
}

export function metaOf(tools: Record<string, ToolDef>): ToolMeta[] {
  return Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object" },
  }));
}
