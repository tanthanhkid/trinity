'use client'

import { SettingsOptionsTable } from './settings-options-table'

export function SettingsContactStages() {
  return (
    <SettingsOptionsTable
      group="contact_stage"
      title="Giai đoạn khách hàng"
      description={
        'Các giai đoạn theo dõi khách hàng (Mới, Đang tư vấn, Đã mua...). ' +
        'Đây là giá trị hệ thống, chỉ cho sửa nhãn/thứ tự.'
      }
      valueHint="in_progress"
    />
  )
}
