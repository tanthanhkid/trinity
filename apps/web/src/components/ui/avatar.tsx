"use client"

import * as React from "react"
import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar"

import { cn } from "@/lib/utils"
import { shellInitials } from "@/components/app-shell/avatar"

/**
 * `kind` (thêm cho «Ánh xanh», docs/design/anh-xanh.md) — KHÁCH bo 30% nền xanh nhạt chữ #285680,
 * NHÂN VIÊN tròn nền trung tính chữ #3E4350; viền là bóng trong 1px. Không truyền `kind` thì
 * giữ nguyên dáng cũ. Size thêm `xl` (48) / `2xl` (64) cho đầu hồ sơ.
 *
 * @example
 * <Avatar kind="customer" size="lg"><AvatarImage src={c.avatarUrl} /><AvatarFallback>{initials}</AvatarFallback></Avatar>
 * <PersonAvatar kind="staff" name={user.name} src={user.avatarUrl} />
 */
function Avatar({
  className,
  size = "default",
  kind,
  ...props
}: AvatarPrimitive.Root.Props & {
  size?: "default" | "sm" | "lg" | "xl" | "2xl"
  kind?: "customer" | "staff"
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      data-kind={kind}
      className={cn(
        "group/avatar relative flex size-8 shrink-0 rounded-full select-none after:absolute after:inset-0 after:rounded-full after:border after:border-border after:mix-blend-darken data-[size=lg]:size-10 data-[size=sm]:size-6 data-[size=xl]:size-12 data-[size=2xl]:size-16 dark:after:mix-blend-lighten",
        "data-[kind=customer]:rounded-[30%] data-[kind=customer]:after:rounded-[30%] data-[kind]:after:border-0 data-[kind]:after:shadow-[var(--ax-shadow-avatar)] data-[kind]:after:mix-blend-normal",
        className
      )}
      {...props}
    />
  )
}

function AvatarImage({ className, ...props }: AvatarPrimitive.Image.Props) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn(
        "aspect-square size-full rounded-full object-cover group-data-[kind=customer]/avatar:rounded-[30%]",
        className
      )}
      {...props}
    />
  )
}

function AvatarFallback({
  className,
  ...props
}: AvatarPrimitive.Fallback.Props) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground group-data-[size=sm]/avatar:text-xs",
        "group-data-[kind]/avatar:font-semibold group-data-[size=lg]/avatar:text-[15px] group-data-[size=xl]/avatar:text-base group-data-[size=2xl]/avatar:text-xl",
        "group-data-[kind=customer]/avatar:rounded-[30%] group-data-[kind=customer]/avatar:ax-grad-avatar-customer group-data-[kind=customer]/avatar:text-[var(--ax-avatar-customer-ink)]",
        "group-data-[kind=staff]/avatar:ax-grad-avatar-staff group-data-[kind=staff]/avatar:text-[var(--ax-avatar-staff-ink)]",
        className
      )}
      {...props}
    />
  )
}

function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground bg-blend-color ring-2 ring-background select-none",
        "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
        "group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
        "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroupCount({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground ring-2 ring-background group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 [&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3",
        className
      )}
      {...props}
    />
  )
}

/** Avatar dựng sẵn từ tên + ảnh (chữ cái đầu khi không có ảnh). */
function PersonAvatar({
  name,
  src,
  kind,
  size = "default",
  className,
}: {
  name: string | null | undefined
  src?: string | null
  kind: "customer" | "staff"
  size?: "default" | "sm" | "lg" | "xl" | "2xl"
  className?: string
}) {
  return (
    <Avatar kind={kind} size={size} className={className}>
      {src ? <AvatarImage src={src} alt={name ?? ""} /> : null}
      <AvatarFallback>{shellInitials(name)}</AvatarFallback>
    </Avatar>
  )
}

export {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarBadge,
  PersonAvatar,
}
