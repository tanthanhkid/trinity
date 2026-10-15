import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const LONG = 'Trưởng phòng Kinh doanh — Khu vực phía Nam và miền Trung của công ty'

describe('Select popup với value dài', () => {
  it('popup rộng theo nội dung (min = trigger, có trần theo viewport), item cho xuống dòng', () => {
    render(
      <Select open value="a">
        <SelectTrigger aria-label="Phòng KD"><SelectValue>{() => LONG}</SelectValue></SelectTrigger>
        <SelectContent>
          <SelectItem value="a">{LONG}</SelectItem>
        </SelectContent>
      </Select>,
    )
    const popup = document.querySelector('[data-slot="select-content"]') as HTMLElement
    expect(popup).not.toBeNull()
    expect(popup.className).toContain('w-max')
    expect(popup.className).toContain('min-w-(--anchor-width)')
    expect(popup.className).toContain('100vw')
    expect(popup.className).not.toMatch(/(^|\s)w-\(--anchor-width\)/)
    const text = screen.getAllByText(LONG).find((e) => e.closest('[data-slot="select-item"]'))!
    expect(text.className).toContain('whitespace-normal')
    expect(text.className).not.toContain('whitespace-nowrap')
  })
})
