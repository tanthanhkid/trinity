import { redactUrl } from './redact-url'

describe('redactUrl', () => {
  it('che token webhook vào, giữ phần còn lại', () => {
    expect(redactUrl('/api/v1/hooks/in/whk_AbC-123_xyz?x=1')).toBe('/api/v1/hooks/in/[redacted]?x=1')
    expect(redactUrl('/api/v1/hooks/in/whk_abc')).toBe('/api/v1/hooks/in/[redacted]')
    expect(redactUrl('POST https://x.vn/api/v1/hooks/in/whk_secret failed')).toBe('POST https://x.vn/api/v1/hooks/in/[redacted] failed')
  })
  it('che code/state/token trong query string, giữ tham số khác', () => {
    expect(redactUrl('/api/v1/integrations/oauth/callback?code=abc123&state=xyz&page=2')).toBe(
      '/api/v1/integrations/oauth/callback?code=[redacted]&state=[redacted]&page=2',
    )
    expect(redactUrl('/x?a=1&access_token=T0K&client_secret=S')).toBe('/x?a=1&access_token=[redacted]&client_secret=[redacted]')
    expect(redactUrl('/x?CODE=abc#frag')).toBe('/x?CODE=[redacted]#frag')
    expect(redactUrl('/wh?hub.mode=subscribe&hub.verify_token=VT&hub.challenge=1')).toBe('/wh?hub.mode=subscribe&hub.verify_token=[redacted]&hub.challenge=1')
    expect(redactUrl('/x?verify_token=VT&oauth_token=OT&page=2')).toBe('/x?verify_token=[redacted]&oauth_token=[redacted]&page=2')
    expect(redactUrl('/x?postcode=7000')).toBe('/x?postcode=7000')
  })
  it('đường dẫn khác không đổi; undefined/rỗng giữ nguyên', () => {
    expect(redactUrl('/api/v1/contacts?page=1')).toBe('/api/v1/contacts?page=1')
    expect(redactUrl('/api/v1/hooks/out')).toBe('/api/v1/hooks/out')
    expect(redactUrl(undefined)).toBeUndefined()
    expect(redactUrl('')).toBe('')
  })
})
