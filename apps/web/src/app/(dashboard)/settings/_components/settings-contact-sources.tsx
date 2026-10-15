'use client'

import { SettingsOptionsTable } from './settings-options-table'

export function SettingsContactSources() {
  return (
    <SettingsOptionsTable
      group="contact_source"
      title="Nguồn khách (Thủ công)"
      description={
        'Danh sách nguồn khách CHỌN TAY khi tạo khách hàng ở /contacts/new ' +
        '(Facebook, Zalo, giới thiệu...). ' +
        'Các giá trị hệ thống không xoá được.'
      }
      valueHint="facebook"
    />
  )
}
