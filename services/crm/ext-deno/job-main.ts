// Điểm vào CỐ ĐỊNH của MỘT tiến trình chạy một lần (job theo lịch, chạy thử, gọi thử tool). Mã khách đến qua stdin và được
// nạp bằng `import()` động từ URL `data:`. KHÔNG ghi mã khách ra file rồi `deno run file`: import TĨNH trong graph chính của Deno
// KHÔNG bị --allow-read chặn (mã khách đọc được mọi file .json/.js bằng `import x from "file:///..."`); qua `import()` từ data: thì bị chặn.
import { type Gateway, makeCtx } from "./ctx.ts";
import { dataUrl, resolveTools } from "./module.ts";

interface RunInput {
  kind: "job" | "tool" | "api";
  code: string;
  params: unknown;
  gateway?: Gateway;
  dryRun?: boolean;
  /** kind=tool: tên tool + tham số gọi thử. */
  tool?: string;
  args?: unknown;
  inputSchema?: Record<string, unknown>;
}

const input = JSON.parse(await new Response(Deno.stdin.readable).text()) as RunInput;
console.log("__EXT_READY__");
const mod = (await import(dataUrl(input.code))) as Record<string, unknown>;
const ctx = makeCtx(input.params, input.gateway, input.dryRun === true);
let result: unknown;
if (input.kind === "job") {
  if (typeof mod.default !== "function") throw new Error("mã chương trình con phải `export default` một hàm");
  result = await (mod.default as (c: unknown) => unknown)(ctx);
} else {
  const tools = resolveTools(mod, input.inputSchema);
  const t = tools[input.tool ?? "run"];
  if (!t) throw new Error(`không có tool "${input.tool ?? "run"}"`);
  result = await t.run(input.args ?? {}, ctx);
}
console.log(`__EXT_RESULT__ ${JSON.stringify(result ?? null)}`);
