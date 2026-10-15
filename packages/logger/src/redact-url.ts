/**
 * Che bí mật trước khi ghi log: token webhook vào (`/api/v1/hooks/in/<token>`) nằm trong đường dẫn,
 * còn mã OAuth (`code`, `state`) và token nằm trong query string — cả hai đều KHÔNG được vào file log/ELK.
 * Chuỗi không khớp → trả y nguyên.
 */
const SECRET_PATH_SEGMENTS: ReadonlyArray<[RegExp, string]> = [[/(\/hooks\/in\/)[^/?#\s]+/g, '$1[redacted]']]

const SECRET_QUERY_KEYS = [
  'code',
  'state',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'secret',
  'password',
  'api_key',
  'apikey',
  'key',
  'signature',
  'verify_token',
  'hub.verify_token',
  'oauth_token',
  'oauth_token_secret',
]
const SECRET_QUERY_RE = new RegExp(`([?&](?:${SECRET_QUERY_KEYS.map((k) => k.replace(/\./g, '\\.')).join('|')})=)[^&#\\s]*`, 'gi')

export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url
  let out = url
  for (const [re, repl] of SECRET_PATH_SEGMENTS) out = out.replace(re, repl)
  return out.replace(SECRET_QUERY_RE, '$1[redacted]')
}
