'use client'

import { SettingsOptionsTable } from './settings-options-table'

/**
 * Cài đặt › Danh mục khách hàng — gộp ba danh sách tự khai (nguồn khách, giai đoạn, trạng thái chăm sóc) vào một mục.
 * Mỗi công ty tự thêm, đổi tên, sắp xếp, tắt mục không dùng; mục hệ thống chỉ không xoá được (tắt thì vẫn ẩn).
 */
export function SettingsCustomerLists() {
  return (
    <div className="space-y-8">
      <SettingsOptionsTable
        group="contact_source"
        title="Nguồn khách"
        description="Khách biết đến bạn qua đâu (Facebook, Zalo, giới thiệu…). Thêm nguồn của riêng bạn, tắt nguồn không dùng."
        valueHint="facebook"
      />
      <SettingsOptionsTable
        group="contact_stage"
        title="Giai đoạn khách hàng"
        description="Các bước chăm sóc khách trước khi chốt. Đổi tên và thứ tự cho khớp cách công ty bạn bán hàng."
        valueHint="in_progress"
      />
      <SettingsOptionsTable
        group="contact_detail_status"
        title="Trạng thái chăm sóc"
        description="Nhân viên đánh dấu sau mỗi lần liên hệ khách (hẹn gọi lại, chưa liên hệ được…)."
        valueHint="follow_up_later"
      />
    </div>
  )
}
