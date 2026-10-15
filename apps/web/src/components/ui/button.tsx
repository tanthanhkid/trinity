"use client"

import { Button as ButtonPrimitive } from "@base-ui/react/button"

import { cn } from "@/lib/utils"
import { buttonVariants, type ButtonVariantsProps } from "@/components/ui/button-variants"

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & ButtonVariantsProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      /* `data-variant`/`data-size`: KHÔNG dùng ở v1 — chỉ để CSS của giao diện
       * v2 (`styles/app-tokens.css`, khối "nút v2") nhận ra biến thể mà chuẩn hoá
       * hover về đúng theme. Thêm attribute là ADDITIVE: v1 không có rule nào
       * bám vào chúng nên diện mạo v1 KHÔNG đổi 1 pixel. */
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
