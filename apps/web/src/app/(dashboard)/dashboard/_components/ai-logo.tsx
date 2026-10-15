import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AI_LOGO_SRC, aiClientKind } from './home-utils'

/**
 * Logo trợ lý theo tên client OAuth: ChatGPT / Claude / Gemini dùng logo SVG; tên khác ⇒ biểu tượng robot chung.
 * Nền trắng ở cả chế độ tối (logo hãng vẽ cho nền sáng) — đúng như bản demo.
 */
export function AiLogo({ name, size = 28, className }: { name: string | null | undefined; size?: number; className?: string }) {
  const kind = aiClientKind(name)
  return (
    <span
      className={cn('grid shrink-0 place-items-center rounded-full border border-[var(--border)] bg-white', className)}
      style={{ width: size, height: size }}
      data-ai-kind={kind}
    >
      {kind === 'other' ? (
        <Bot className="size-[60%] text-[#4a4d57]" aria-hidden />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={AI_LOGO_SRC[kind]} alt="" width={size} height={size} className="size-[62%] object-contain" />
      )}
    </span>
  )
}
