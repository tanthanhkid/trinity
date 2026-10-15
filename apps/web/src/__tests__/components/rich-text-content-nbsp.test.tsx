import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  RichTextContent,
  isHtmlContent,
  normalizeLegacyEntities,
} from '@/components/ui/rich-text-content'

describe('RichTextContent — &nbsp;', () => {
  it('"IT test 2&nbsp;" không còn hiện chữ &nbsp;', () => {
    const { container } = render(<RichTextContent html="IT test 2&nbsp;" />)
    expect(container.textContent).not.toContain('&nbsp;')
    expect(container.textContent?.replace(/ /g, ' ').trim()).toBe('IT test 2')
  })
  it('dữ liệu cũ escape 2 lần (&amp;nbsp;) cũng sạch', () => {
    const { container } = render(<RichTextContent html="IT test 2&amp;nbsp;" />)
    expect(container.textContent).not.toContain('nbsp')
  })
  it('isHtmlContent nhận &nbsp; là HTML; normalizeLegacyEntities đổi &amp;nbsp;', () => {
    expect(isHtmlContent('a&nbsp;')).toBe(true)
    expect(normalizeLegacyEntities('a&amp;nbsp;b')).toBe('a b')
  })
  it('vẫn chặn XSS', () => {
    const { container } = render(<RichTextContent html={'x&nbsp;<img src=x onerror=alert(1)><script>1</script>'} />)
    expect(container.innerHTML).not.toMatch(/<img|<script|onerror/i)
  })
})
