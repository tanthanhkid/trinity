import Link from "next/link"
import { Compass, Home } from "lucide-react"
import { buttonVariants } from "@/components/ui/button-variants"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-md space-y-6 rounded-[var(--radius)] border border-[var(--border)] bg-card p-8 text-center shadow-[var(--shadow-card)]">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--muted)] text-muted-foreground">
          <Compass className="h-7 w-7" aria-hidden />
        </div>

        <div className="space-y-2">
          <p className="text-[40px] font-semibold tracking-tight text-foreground">404</p>
          <h1 className="text-[17px] font-semibold text-foreground">Không tìm thấy trang</h1>
          <p className="text-sm text-muted-foreground">
            Trang bạn tìm kiếm không tồn tại hoặc đã được di chuyển.
          </p>
        </div>

        <Link
          href="/dashboard"
          className={cn(buttonVariants(), "h-10 w-full rounded-lg text-sm")}
        >
          <Home className="mr-2 h-4 w-4" aria-hidden />
          Về trang Tổng quan
        </Link>
      </div>
    </div>
  )
}
