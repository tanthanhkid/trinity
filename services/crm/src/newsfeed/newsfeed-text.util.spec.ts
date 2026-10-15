import { stripHtmlToText } from './newsfeed-text.util';

describe('stripHtmlToText', () => {
  it('giải mã &nbsp; thành khoảng trắng và cắt đuôi', () => {
    expect(stripHtmlToText('IT test 2&nbsp;')).toBe('IT test 2');
  });
  it('xử lý dữ liệu cũ bị escape 2 lần (&amp;nbsp;)', () => {
    expect(stripHtmlToText('IT test 2&amp;nbsp;')).toBe('IT test 2');
  });
  it('bỏ thẻ, gộp khoảng trắng, giải mã entity thường gặp', () => {
    expect(stripHtmlToText('<p>A&nbsp;&nbsp;B &amp; C &lt;x&gt; &#39;q&#39; &#160;D</p>')).toBe("A B & C <x> 'q' D");
  });
  it('không ném lỗi với code point sai', () => {
    expect(stripHtmlToText('a&#99999999999;b')).toBe('a b');
  });
});
