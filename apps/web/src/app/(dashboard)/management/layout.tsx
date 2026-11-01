"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useIsSingleUserCompany } from "@/lib/tenant/single-user"

/** Công ty một người (SaaS) không có nhân sự để quản lý: mở thẳng link cũ thì về Tổng quan. */
export default function ManagementLayout({ children }: { children: React.ReactNode }) {
  const singleUser = useIsSingleUserCompany()
  const router = useRouter()
  useEffect(() => {
    if (singleUser) router.replace("/dashboard")
  }, [singleUser, router])
  if (singleUser) return null
  return <>{children}</>
}
