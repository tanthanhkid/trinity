import type { ReactNode } from "react"

/**
 * Khung trang chính sách công khai (không cần đăng nhập). Liên hệ lấy từ `LEGAL_CONTACT_EMAIL`, đơn vị vận hành từ `LEGAL_COMPANY_*`
 * của bản cài (mỗi công ty tự cài Trinity ghi pháp nhân của mình; để trống thì không hiện).
 */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  const company = legalCompany()
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10 text-sm leading-relaxed [&_h2]:mt-8 [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p]:text-foreground/90">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-muted-foreground">Cập nhật {updated}</p>
      </header>
      {children}
      {company && (
        <footer className="mt-10 space-y-0.5 border-t pt-4 text-muted-foreground">
          <p className="font-medium text-foreground">{company.name}</p>
          {company.englishName && <p>{company.englishName}</p>}
          {company.taxId && <p>Mã số doanh nghiệp: {company.taxId}</p>}
          {company.address && <p>Địa chỉ: {company.address}</p>}
          {company.phone && <p>Điện thoại: {company.phone}</p>}
          {process.env.LEGAL_CONTACT_EMAIL?.trim() && <p>Email: {process.env.LEGAL_CONTACT_EMAIL.trim()}</p>}
        </footer>
      )}
    </main>
  )
}

export function legalContact(): string {
  return process.env.LEGAL_CONTACT_EMAIL?.trim() || "quản trị viên của hệ thống Trinity bạn đang dùng"
}

export function legalCompany(): { name: string; englishName?: string; taxId?: string; address?: string; phone?: string } | null {
  const v = (k: string) => process.env[k]?.trim() || undefined
  const name = v("LEGAL_COMPANY_NAME")
  if (!name) return null
  return { name, englishName: v("LEGAL_COMPANY_NAME_EN"), taxId: v("LEGAL_COMPANY_TAX_ID"), address: v("LEGAL_COMPANY_ADDRESS"), phone: v("LEGAL_COMPANY_PHONE") }
}
