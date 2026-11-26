import { webTunnelListenProblem } from "@/lib/client-ip-headers"

/** Kiểm lúc khởi động máy chủ Next (Node): `cloudflare-tunnel` mà web không nghe loopback ⇒ không lên. */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const problem = webTunnelListenProblem(process.env)
  if (problem) {
    console.error(`Không khởi động: ${problem}`)
    process.exit(1)
  }
}
