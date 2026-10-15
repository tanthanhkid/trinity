'use client'

import { SettingsOptionsTable } from './settings-options-table'

export function SettingsContactStatuses() {
  return (
    <SettingsOptionsTable
      group="contact_detail_status"
      title="Trạng thái chi tiết khách hàng"
      description={
        'Trạng thái nhân viên đánh dấu sau mỗi lần tương tác (Đang tư vấn, ' +
        'Đã báo giá, Đã mua, Không quan tâm...). Thêm/sửa/xoá tuỳ ý.'
      }
      valueHint="in_progress"
    />
  )
}
