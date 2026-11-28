import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { OtpInput, isCompleteCode } from '@/components/auth/otp-input'

function Harness({ onComplete }: { onComplete?: (v: string) => void }) {
  const [v, setV] = useState('')
  return (
    <>
      <OtpInput value={v} onChange={setV} onComplete={onComplete} />
      <output data-testid="v">{v}</output>
    </>
  )
}

const box = (i: number) => screen.getByLabelText(`Chữ số ${i}`) as HTMLInputElement
const values = () => [1, 2, 3, 4, 5, 6].map((i) => box(i).value).join(',')

describe('OtpInput (#675)', () => {
  it('dán đủ 6 số: điền cả và tự gửi', () => {
    const done = vi.fn()
    render(<Harness onComplete={done} />)
    fireEvent.paste(box(3), { clipboardData: { getData: () => 'Mã: 123 456' } })
    expect(values()).toBe('1,2,3,4,5,6')
    expect(done).toHaveBeenCalledWith('123456')
  })

  it('sửa một ô giữa không xoá các ô sau; gõ thêm vào ô đã có số chỉ lấy số mới', () => {
    render(<Harness />)
    fireEvent.paste(box(1), { clipboardData: { getData: () => '123456' } })
    fireEvent.change(box(3), { target: { value: '39' } })
    expect(values()).toBe('1,2,9,4,5,6')
    fireEvent.change(box(4), { target: { value: '74' } })
    expect(values()).toBe('1,2,9,7,5,6')
  })

  it('xoá không qua Backspace (Delete, cắt, IME) chỉ xoá đúng ô đó; chưa đủ thì không tự gửi', () => {
    const done = vi.fn()
    render(<Harness onComplete={done} />)
    fireEvent.paste(box(1), { clipboardData: { getData: () => '123456' } })
    done.mockClear()
    fireEvent.change(box(2), { target: { value: '' } })
    expect(values()).toBe('1,,3,4,5,6')
    expect(isCompleteCode(screen.getByTestId('v').textContent ?? '')).toBe(false)
    fireEvent.keyDown(box(4), { key: 'Backspace' })
    expect(values()).toBe('1,,3,,5,6')
    fireEvent.change(box(2), { target: { value: '2' } })
    fireEvent.change(box(4), { target: { value: '4' } })
    expect(done).toHaveBeenLastCalledWith('123456')
  })
})
