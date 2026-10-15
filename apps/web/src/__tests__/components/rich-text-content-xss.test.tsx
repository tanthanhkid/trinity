import { describe, it, expect } from 'vitest'
import { sanitizeHtml } from '@/components/ui/rich-text-content'

describe('sanitizeHtml — thẻ bị unwrap vẫn phải walk lại các con', () => {
  it('<a> không href chứa <img onerror>', () => {
    const out = sanitizeHtml('<a><img src=x onerror=alert(1)></a>')
    expect(out).not.toMatch(/<img|onerror/i)
  })
  it('thẻ lạ <section> chứa <img onerror>', () => {
    const out = sanitizeHtml('<section><img src=x onerror=alert(1)></section>')
    expect(out).not.toMatch(/<img|onerror/i)
  })
  it('lồng nhiều tầng thẻ lạ', () => {
    const out = sanitizeHtml('<section><article><a href="javascript:alert(1)">x</a></article></section>')
    expect(out).not.toMatch(/javascript|<a/i)
    expect(out).toContain('x')
  })
  it('giữ nguyên thẻ hợp lệ và chữ', () => {
    expect(sanitizeHtml('<section><b>hi</b> <i>there</i></section>')).toBe('<b>hi</b> <i>there</i>')
  })
})
