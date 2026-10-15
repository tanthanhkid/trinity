"use client"

import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { ShellTabsContent as TabsContent, ShellTabs as Tabs, ShellTabsList as TabsList, ShellTabsTrigger as TabsTrigger } from "@/components/app-shell/tabs"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { Skeleton } from "@/components/ui/skeleton"
import { PermissionGate, usePermissions } from "@/lib/rbac"

const TabSkeleton = () => <Skeleton className="h-64 w-full rounded-2xl mt-4" />

const PayrollEmployees = dynamic(
  () => import("./_components/payroll-employees").then((m) => ({ default: m.PayrollEmployees })),
  { loading: TabSkeleton },
)
const PayrollPayslips = dynamic(
  () => import("./_components/payroll-payslips").then((m) => ({ default: m.PayrollPayslips })),
  { loading: TabSkeleton },
)
const PayrollReports = dynamic(
  () => import("./_components/payroll-reports").then((m) => ({ default: m.PayrollReports })),
  { loading: TabSkeleton },
)
const PayrollSalaryComponents = dynamic(
  () => import("./_components/payroll-salary-components").then((m) => ({ default: m.PayrollSalaryComponents })),
  { loading: TabSkeleton },
)
const PayrollInsuranceSettings = dynamic(
  () => import("./_components/payroll-insurance-settings").then((m) => ({ default: m.PayrollInsuranceSettings })),
  { loading: TabSkeleton },
)
const PayrollTaxConfig = dynamic(
  () => import("./_components/payroll-tax-config").then((m) => ({ default: m.PayrollTaxConfig })),
  { loading: TabSkeleton },
)

export default function PayrollPage() {
  // Mọi tab đều cần ít nhất `payroll.view` (phiếu lương) — thiếu thì Forbidden, 0 request.
  return (
    <PermissionGate permission="payroll.view">
      <PayrollTabs />
    </PermissionGate>
  )
}

function PayrollTabs() {
  // Tab "Nhân viên" gọi `GET /management/employees` (BE gate `employees.view`) —
  // thiếu quyền thì ẩn tab + mặc định sang "Phiếu lương" (không gọi API → không 403).
  const { can } = usePermissions()
  const canViewEmployees = can("employees.view")
  // Thành phần lương / Bảo hiểm / Thuế / Báo cáo: BE gate `payroll.manage` (cả GET).
  const canManage = can("payroll.manage")
  const [tab, setTab] = useState(canViewEmployees ? "employees" : "payslips")
  // 7 tab cuộn ngang trên điện thoại — đưa tab đang chọn vào giữa khung (chỉ <640px).
  useEffect(() => {
    if (!window.matchMedia("(max-width: 639px)").matches) return
    document
      .querySelector<HTMLElement>('[role="tab"][data-active]')
      ?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" })
  }, [tab])
  return (
    <div className="space-y-6">
      <ShellPageHeader title="Lương" />
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList layout="wrap">
          {canViewEmployees && <TabsTrigger value="employees">Nhân viên</TabsTrigger>}
          <TabsTrigger value="payslips">Phiếu lương</TabsTrigger>
          {canManage && <TabsTrigger value="salary-components">Thành phần lương</TabsTrigger>}
          {canManage && <TabsTrigger value="insurance">Bảo hiểm</TabsTrigger>}
          {canManage && <TabsTrigger value="tax">Thuế TNCN</TabsTrigger>}
          {canManage && <TabsTrigger value="reports">Báo cáo</TabsTrigger>}
        </TabsList>
        {canViewEmployees && (
          <TabsContent value="employees" className="mt-4">
            <PayrollEmployees />
          </TabsContent>
        )}
        <TabsContent value="payslips" className="mt-4">
          <PayrollPayslips />
        </TabsContent>
        {canManage && (
          <TabsContent value="salary-components" className="mt-4">
            <PayrollSalaryComponents />
          </TabsContent>
        )}
        {canManage && (
          <TabsContent value="insurance" className="mt-4">
            <PayrollInsuranceSettings />
          </TabsContent>
        )}
        {canManage && (
          <TabsContent value="tax" className="mt-4">
            <PayrollTaxConfig />
          </TabsContent>
        )}
        {canManage && (
          <TabsContent value="reports" className="mt-4">
            <PayrollReports />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
