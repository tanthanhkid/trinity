"use client"

import type { ReactNode } from "react"
import { useSiteConfig } from "@/lib/use-site-config"

/**
 * Khung trang chính sách công khai (không cần đăng nhập). Thông tin pháp lý lấy LÚC CHẠY từ `GET /api/v1/site-config`
 * (`LEGAL_*` của bản cài; mỗi công ty tự cài Trinity ghi pháp nhân của mình, để trống thì không hiện). Đổi env rồi khởi động
 * lại binary là đổi, không build lại web.
 */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  const legal = useSiteConfig()?.legal
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10 text-sm leading-relaxed [&_h2]:mt-8 [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p]:text-foreground/90">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-muted-foreground">Cập nhật {updated}</p>
      </header>
      {children}
      {legal?.company_name && (
        <footer className="mt-10 space-y-0.5 border-t pt-4 text-muted-foreground">
          <p className="font-medium text-foreground">{legal.company_name}</p>
          {legal.company_name_en && <p>{legal.company_name_en}</p>}
          {legal.company_tax_id && <p>Mã số doanh nghiệp: {legal.company_tax_id}</p>}
          {legal.company_address && <p>Địa chỉ: {legal.company_address}</p>}
          {legal.company_phone && <p>Điện thoại: {legal.company_phone}</p>}
          {legal.contact_email && <p>Email: {legal.contact_email}</p>}
        </footer>
      )}
    </main>
  )
}

export const LEGAL_CONTACT_FALLBACK = "quản trị viên của hệ thống Trinity bạn đang dùng"

/** Chuỗi liên hệ (email của bản cài, không có thì câu chung) để chèn vào câu văn. */
export function LegalContact() {
  return <>{useSiteConfig()?.legal.contact_email ?? LEGAL_CONTACT_FALLBACK}</>
}
