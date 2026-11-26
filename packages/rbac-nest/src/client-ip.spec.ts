import {
  CLIENT_IP_HEADER,
  DEFAULT_CLOUDFLARE_IP_RANGES,
  UNTRUSTED_CLIENT_IP,
  __resetClientIpStateForTest,
  __setClockForTest,
  __setRouteTableForTest,
  clientIpMiddleware,
  clientIpStartupProblems,
  clientIpStartupWarnings,
  clientIpWarning,
  defaultGateway,
  determineClientIp,
  normalizeIp,
  parseTrustedProxy,
  resolveClientIp,
  signClientIp,
  tunnelListenProblem,
  type ClientIpRequest,
} from './client-ip'

/** Địa chỉ dùng trong bảng ca. */
const CF_PEER = '172.70.1.1' // thuộc 172.64.0.0/13 (Cloudflare)
const PUBLIC_PEER = '198.51.100.9' // ngoài mọi danh sách
const REAL = '203.0.113.50' // IP thật của khách
const FAKE = '203.0.113.108' // IP văn phòng mà kẻ gian tự khai
const GATEWAY = '172.18.0.1'
const ROUTE_TABLE = 'Iface\tDestination\tGateway\tFlags\neth0\t00000000\t010012AC\t0003\neth0\t000012AC\t00000000\t0001\n'

const SECRET_A = 'a'.repeat(64) // INTERNAL_SERVICE_SECRET
const SECRET_B = 'b'.repeat(64) // SERVICE_SECRET
const NOW = 1_800_000_000

function req(peer: string | undefined, headers: Record<string, string> = {}): ClientIpRequest {
  return { headers, socket: { remoteAddress: peer } }
}

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { INTERNAL_SERVICE_SECRET: SECRET_A, SERVICE_SECRET: SECRET_B, ...extra } as NodeJS.ProcessEnv
}

function ip(r: ClientIpRequest, e: NodeJS.ProcessEnv): string | null {
  const d = determineClientIp(r, e)
  if (!d.ok) throw new Error(`không mong 400: ${d.error}`)
  return d.client.ip
}

beforeEach(() => {
  __resetClientIpStateForTest()
  __setRouteTableForTest(ROUTE_TABLE)
  __setClockForTest(() => NOW * 1000)
})
afterAll(() => {
  __setRouteTableForTest(undefined)
  __setClockForTest(null)
})

describe('normalizeIp', () => {
  it('chuẩn hoá IPv4-mapped trước mọi so khớp; không phải IP thì null', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeIp(' ::FFFF:203.0.113.5 ')).toBe('203.0.113.5')
    expect(normalizeIp('[2001:DB8::1]')).toBe('2001:db8::1')
    expect(normalizeIp('203.0.113.5, 1.2.3.4')).toBeNull()
    expect(normalizeIp('unknown')).toBeNull()
    expect(normalizeIp(undefined)).toBeNull()
  })
})

describe('defaultGateway (/proc/net/route)', () => {
  it('đọc tuyến mặc định little-endian', () => {
    expect(defaultGateway()).toBe(GATEWAY)
  })
  it('không có tệp ⇒ null', () => {
    __setRouteTableForTest(null)
    expect(defaultGateway()).toBeNull()
  })
  it('ngoài container (máy chủ thường, tuyến mặc định là router LAN) ⇒ luật cổng mặc định không áp', () => {
    __setRouteTableForTest(ROUTE_TABLE, false)
    expect(defaultGateway()).toBeNull()
    // peer bằng địa chỉ router nhưng là IP công cộng giả định: không bị coi là "cổng container"
    expect(ip(req(PUBLIC_PEER), env())).toBe(PUBLIC_PEER)
  })
})

describe('parseTrustedProxy', () => {
  it('5 giá trị hợp lệ', () => {
    expect(parseTrustedProxy(undefined)).toEqual({ mode: 'none' })
    expect(parseTrustedProxy('cloudflare')).toEqual({ mode: 'cloudflare' })
    expect(parseTrustedProxy('cloudflare-tunnel')).toEqual({ mode: 'cloudflare-tunnel' })
    expect(parseTrustedProxy('cidr:127.0.0.1/32, 10.0.0.0/8;header=x-real-ip')).toEqual({
      mode: 'cidr',
      entries: ['127.0.0.1/32', '10.0.0.0/8'],
      header: 'x-real-ip',
    })
    expect(parseTrustedProxy('cloudflare-behind:docker-gateway')).toEqual({ mode: 'cloudflare-behind', entries: ['docker-gateway'] })
  })
  it('giá trị sai ⇒ throw kèm bảng cách triển khai', () => {
    expect(() => parseTrustedProxy('true')).toThrow(/cloudflare-behind:127\.0\.0\.1\/32/)
    expect(() => parseTrustedProxy('cidr:')).toThrow(/trống/)
    expect(() => parseTrustedProxy('cidr:300.1.1.1/8')).toThrow(/không phải IP/)
    expect(() => parseTrustedProxy('cidr:127.0.0.1/32;header=cf-connecting-ip')).toThrow(/tuỳ chọn/)
  })
})

/**
 * Bảng ca: 5 giá trị TRUSTED_PROXY × peer trong/ngoài danh sách × header thật/giả.
 * Cột cuối là IP khách mong đợi (`null` = không tin được).
 */
describe('bảng ca TRUSTED_PROXY × peer × header', () => {
  type Row = [string, string | undefined, string, Record<string, string>, string | null]
  const rows: Row[] = [
    // none: không header nào được tin
    ['none, peer công cộng, header giả mọi loại', undefined, PUBLIC_PEER, { 'x-real-ip': FAKE, 'x-forwarded-for': FAKE, 'cf-connecting-ip': FAKE, forwarded: `for=${FAKE}` }, PUBLIC_PEER],
    ['none, peer Cloudflare + cf-connecting-ip thật ⇒ vẫn IP peer', 'none', CF_PEER, { 'cf-connecting-ip': REAL }, CF_PEER],
    ['none, peer loopback (proxy chưa khai báo) ⇒ không tin được', 'none', '127.0.0.1', { 'x-real-ip': REAL }, null],
    ['none, peer ::ffff:127.0.0.1 ⇒ không tin được', 'none', '::ffff:127.0.0.1', {}, null],
    ['none, peer là cổng mặc định container (docker-proxy) ⇒ không tin được', 'none', GATEWAY, { 'x-forwarded-for': REAL }, null],
    ['none, khách LAN của bản cài tại chỗ (mạng riêng) là khách thật', 'none', '192.168.1.20', { 'x-forwarded-for': FAKE }, '192.168.1.20'],
    ['none, khách LAN IPv6 ULA là khách thật', 'none', 'fd00::5', {}, 'fd00::5'],
    // cloudflare
    ['cloudflare, peer trong dải CF + cf-connecting-ip', 'cloudflare', CF_PEER, { 'cf-connecting-ip': REAL, 'x-real-ip': FAKE }, REAL],
    ['cloudflare, peer IPv6 trong dải CF', 'cloudflare', '2606:4700::1', { 'cf-connecting-ip': REAL }, REAL],
    ['cloudflare, peer ngoài dải + cf-connecting-ip giả ⇒ IP peer', 'cloudflare', PUBLIC_PEER, { 'cf-connecting-ip': FAKE }, PUBLIC_PEER],
    ['cloudflare, peer trong dải nhưng thiếu header ⇒ không tin được', 'cloudflare', CF_PEER, {}, null],
    ['cloudflare, peer là cổng mặc định (CF nối IPv6 qua docker-proxy) ⇒ không tin được', 'cloudflare', GATEWAY, { 'cf-connecting-ip': FAKE }, null],
    ['cloudflare, peer mạng riêng ngoài dải CF + cf-connecting-ip giả ⇒ IP peer', 'cloudflare', '10.1.2.3', { 'cf-connecting-ip': FAKE }, '10.1.2.3'],
    // cloudflare-tunnel
    ['cloudflare-tunnel, cloudflared trên loopback + cf-connecting-ip', 'cloudflare-tunnel', '127.0.0.1', { 'cf-connecting-ip': REAL }, REAL],
    ['cloudflare-tunnel, thiếu header ⇒ không tin được', 'cloudflare-tunnel', '127.0.0.1', { 'x-real-ip': FAKE }, null],
    ['cloudflare-tunnel, cf-connecting-ip là loopback ⇒ không tin được', 'cloudflare-tunnel', '127.0.0.1', { 'cf-connecting-ip': '127.0.0.1' }, null],
    // cidr (X-Forwarded-For phải cùng)
    ['cidr, peer trong danh sách: phần tử PHẢI CÙNG của XFF (client chèn đầu bị bỏ)', 'cidr:127.0.0.1/32', '127.0.0.1', { 'x-forwarded-for': `${FAKE}, ${REAL}` }, REAL],
    ['cidr, Caddyfile mặc định + X-Real-IP giả ⇒ X-Real-IP bị bỏ qua', 'cidr:127.0.0.1/32', '127.0.0.1', { 'x-real-ip': FAKE, 'x-forwarded-for': REAL }, REAL],
    ['cidr, peer ::ffff:127.0.0.1 khớp 127.0.0.1/32', 'cidr:127.0.0.1/32', '::ffff:127.0.0.1', { 'x-forwarded-for': REAL }, REAL],
    ['cidr, peer ngoài danh sách + header giả ⇒ IP peer', 'cidr:127.0.0.1/32', PUBLIC_PEER, { 'x-forwarded-for': FAKE, 'x-real-ip': FAKE }, PUBLIC_PEER],
    ['cidr, khách LAN ngoài danh sách + XFF giả ⇒ IP peer (khách thật)', 'cidr:127.0.0.1/32', '192.168.1.20', { 'x-forwarded-for': FAKE }, '192.168.1.20'],
    ['cidr, peer mạng riêng TRONG danh sách ⇒ XFF (proxy nội bộ khai báo tường minh)', 'cidr:10.0.0.0/8', '10.0.0.7', { 'x-forwarded-for': REAL }, REAL],
    ['cidr, peer trong danh sách nhưng thiếu XFF ⇒ không tin được', 'cidr:127.0.0.1/32', '127.0.0.1', { 'x-real-ip': REAL }, null],
    ['cidr ;header=x-real-ip, peer trong danh sách', 'cidr:127.0.0.1/32;header=x-real-ip', '127.0.0.1', { 'x-real-ip': REAL, 'x-forwarded-for': FAKE }, REAL],
    ['cidr ;header=x-real-ip, peer ngoài danh sách ⇒ IP peer', 'cidr:127.0.0.1/32;header=x-real-ip', PUBLIC_PEER, { 'x-real-ip': FAKE }, PUBLIC_PEER],
    ['cidr:docker-gateway, peer là cổng mặc định ⇒ XFF', 'cidr:docker-gateway', GATEWAY, { 'x-forwarded-for': REAL }, REAL],
    ['cidr ghi sai dải Docker: peer thật là cổng mặc định ⇒ không tin được, không khoá', 'cidr:172.30.0.0/16', GATEWAY, { 'x-forwarded-for': REAL }, null],
    // cloudflare-behind
    ['cloudflare-behind, hop do proxy ghi ∈ CF ⇒ cf-connecting-ip', 'cloudflare-behind:127.0.0.1/32', '127.0.0.1', { 'x-forwarded-for': `${FAKE}, ${CF_PEER}`, 'cf-connecting-ip': REAL }, REAL],
    ['cloudflare-behind, gửi thẳng proxy từ ngoài dải CF + cf-connecting-ip giả ⇒ hop', 'cloudflare-behind:127.0.0.1/32', '127.0.0.1', { 'x-forwarded-for': PUBLIC_PEER, 'cf-connecting-ip': FAKE }, PUBLIC_PEER],
    ['cloudflare-behind, peer ngoài cidr + header giả ⇒ IP peer', 'cloudflare-behind:127.0.0.1/32', PUBLIC_PEER, { 'x-forwarded-for': CF_PEER, 'cf-connecting-ip': FAKE }, PUBLIC_PEER],
    ['cloudflare-behind, hop ∈ CF nhưng thiếu cf-connecting-ip ⇒ không tin được', 'cloudflare-behind:127.0.0.1/32', '127.0.0.1', { 'x-forwarded-for': CF_PEER }, null],
  ]
  it.each(rows)('%s', (_name, tp, peer, headers, expected) => {
    expect(ip(req(peer, headers), env({ TRUSTED_PROXY: tp }))).toBe(expected)
  })

  /**
   * Đối chiếu tệp nạp trước của web (`apps/web/peer-ip.cjs`, JS thuần, chạy trong tiến trình Next) với hàm của API:
   * web là biên, ký giá trị; API (peer = web trên loopback) kiểm chữ ký rồi áp luật "không tin được" — kết quả cuối
   * phải trùng bảng ca ở trên.
   */
  describe('tệp nạp trước của web cho cùng kết quả', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loadPreload = () => {
      process.env.TRINITY_PEER_IP_NO_INSTALL = '1'
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('../../../apps/web/peer-ip.cjs') as {
        prepare(r: ClientIpRequest, e: NodeJS.ProcessEnv): string
      }
    }
    it.each(rows)('%s', (_name, tp, peer, headers, expected) => {
      const preload = loadPreload()
      const e = env({ TRUSTED_PROXY: tp, TRINITY_TEST_ROUTE_TABLE: ROUTE_TABLE, TRINITY_TEST_IN_CONTAINER: '1' })
      const atWeb = req(peer, { ...headers, [CLIENT_IP_HEADER]: 'giả;1;x', 'x-trinity-peer-ip': FAKE })
      __setClockForTest(null) // preload ký theo đồng hồ thật
      preload.prepare(atWeb, e)
      expect(atWeb.headers['x-trinity-peer-ip']).toBeUndefined()
      const atApi = req('127.0.0.1', atWeb.headers as Record<string, string>)
      expect(ip(atApi, env({ TRUSTED_PROXY: 'none' }))).toBe(expected)
    })
  })

  it('CLOUDFLARE_IP_RANGES ghi đè danh sách mặc định (Cloudflare giả trong phòng thử)', () => {
    const e = env({ TRUSTED_PROXY: 'cloudflare', CLOUDFLARE_IP_RANGES: '192.0.2.0/24' })
    expect(ip(req('192.0.2.7', { 'cf-connecting-ip': REAL }), e)).toBe(REAL)
    expect(ip(req(CF_PEER, { 'cf-connecting-ip': FAKE }), e)).toBe(CF_PEER)
  })

  it('không tin được ⇒ khoá tốc độ là IP peer (một xô chung)', () => {
    const d = determineClientIp(req('127.0.0.1', { 'x-real-ip': REAL }), env())
    expect(d.ok && d.client).toMatchObject({ ip: null, rateKey: '127.0.0.1' })
  })

  it('danh sách Cloudflare mặc định có cả IPv4 và IPv6', () => {
    expect(DEFAULT_CLOUDFLARE_IP_RANGES.some((r) => r.includes(':'))).toBe(true)
    expect(DEFAULT_CLOUDFLARE_IP_RANGES).toContain('172.64.0.0/13')
  })
})

describe('x-trinity-client-ip có chữ ký', () => {
  const signed = (value: string, secret = SECRET_A, ts = NOW) => ({ [CLIENT_IP_HEADER]: signClientIp(value, secret, ts) })

  it('chữ ký đúng ⇒ dùng giá trị, bỏ qua TRUSTED_PROXY và header khác', () => {
    const r = req('127.0.0.1', { ...signed(REAL), 'x-real-ip': FAKE, 'cf-connecting-ip': FAKE })
    const d = determineClientIp(r, env({ TRUSTED_PROXY: 'cloudflare' }))
    expect(d).toEqual({ ok: true, client: { ip: REAL, rateKey: REAL, untrustedReason: null, source: 'signed' } })
  })

  it('web ký bằng SERVICE_SECRET, API có cả hai bí mật ⇒ hợp lệ', () => {
    expect(ip(req('10.0.0.5', signed(REAL, SECRET_B)), env())).toBe(REAL)
  })

  it('API chỉ có SERVICE_SECRET, web ký bằng nó ⇒ hợp lệ', () => {
    expect(ip(req('10.0.0.5', signed(REAL, SECRET_B)), { SERVICE_SECRET: SECRET_B } as NodeJS.ProcessEnv)).toBe(REAL)
  })

  it('dấu "untrusted" KHÔNG chữ ký từ web cùng máy (loopback) hoặc proxy khai trong TRUSTED_PROXY ⇒ không tin được', () => {
    let d = determineClientIp(req('127.0.0.1', { [CLIENT_IP_HEADER]: UNTRUSTED_CLIENT_IP }), env())
    expect(d.ok && d.client).toMatchObject({ ip: null, rateKey: '127.0.0.1' })
    d = determineClientIp(req('10.0.0.7', { [CLIENT_IP_HEADER]: UNTRUSTED_CLIENT_IP }), env({ TRUSTED_PROXY: 'cidr:10.0.0.0/8' }))
    expect(d.ok && d.client.ip).toBeNull()
  })

  it('dấu "untrusted" KHÔNG chữ ký gửi thẳng từ ngoài ⇒ bỏ qua header, IP từ peer (không tắt được kiểm Wi-Fi/chấm công)', () => {
    expect(ip(req(PUBLIC_PEER, { [CLIENT_IP_HEADER]: UNTRUSTED_CLIENT_IP }), env())).toBe(PUBLIC_PEER)
    expect(ip(req('192.168.1.20', { [CLIENT_IP_HEADER]: UNTRUSTED_CLIENT_IP }), env({ TRUSTED_PROXY: 'cidr:127.0.0.1/32' }))).toBe('192.168.1.20')
  })

  it('dấu "không tin được" do tiến trình biên ghi ⇒ ip null, khoá tốc độ = peer', () => {
    const d = determineClientIp(req('10.0.0.5', signed(UNTRUSTED_CLIENT_IP)), env())
    expect(d.ok && d.client).toMatchObject({ ip: null, rateKey: '10.0.0.5', source: 'signed' })
  })

  it.each([
    ['chữ ký sai (bí mật khác — lệch bí mật giữa web và API)', () => signed(REAL, 'c'.repeat(64)), /không hợp lệ/],
    ['giá trị bị sửa sau khi ký', () => ({ [CLIENT_IP_HEADER]: signClientIp(REAL, SECRET_A, NOW).replace(REAL, FAKE) }), /không hợp lệ/],
    ['quá hạn (ký 61 giây trước)', () => signed(REAL, SECRET_A, NOW - 61), /hết hạn/],
    ['phát lại sau 60 giây (header cũ dùng lại)', () => signed(REAL, SECRET_A, NOW - 120), /hết hạn/],
    ['thời điểm ở tương lai quá 60 giây', () => signed(REAL, SECRET_A, NOW + 61), /hết hạn/],
    ['sai định dạng', () => ({ [CLIENT_IP_HEADER]: FAKE }), /định dạng/],
    ['giá trị không phải IP', () => signed('not-an-ip'), /định dạng/],
  ])('%s ⇒ 400', (_n, headers, msg) => {
    const d = determineClientIp(req('127.0.0.1', headers()), env())
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.error).toMatch(msg)
  })

  it('đúng mép 60 giây vẫn hợp lệ', () => {
    expect(ip(req('127.0.0.1', signed(REAL, SECRET_A, NOW - 60)), env())).toBe(REAL)
  })

  it('API không có bí mật nội bộ mà nhận header ⇒ 400 (không cho qua)', () => {
    const d = determineClientIp(req('127.0.0.1', signed(REAL)), {} as NodeJS.ProcessEnv)
    expect(d.ok).toBe(false)
  })

  it('IP có chữ ký là loopback ⇒ vẫn áp luật không tin được', () => {
    expect(ip(req('10.0.0.5', signed('127.0.0.1')), env())).toBeNull()
  })
})

describe('clientIpMiddleware', () => {
  const res = () => {
    const r = { statusCode: 200, headers: {} as Record<string, string>, body: '', setHeader(n: string, v: string) { r.headers[n] = v }, end(b: string) { r.body = b } }
    return r
  }
  const ORIGINAL = { ...process.env }
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = SECRET_A
    process.env.SERVICE_SECRET = SECRET_B
    delete process.env.TRUSTED_PROXY
  })
  afterAll(() => {
    process.env = ORIGINAL
  })

  it('chữ ký sai ⇒ 400 ngay, không gọi next', () => {
    const r = res()
    const next = jest.fn()
    clientIpMiddleware(req('127.0.0.1', { [CLIENT_IP_HEADER]: signClientIp(REAL, 'x'.repeat(40), NOW) }), r, next)
    expect(r.statusCode).toBe(400)
    expect(next).not.toHaveBeenCalled()
    expect(JSON.parse(r.body)).toMatchObject({ statusCode: 400 })
  })

  it('kiểm lúc nhận header rồi lưu: body tới chậm 61 giây sau vẫn dùng kết quả đã kiểm', () => {
    const r = req('127.0.0.1', { [CLIENT_IP_HEADER]: signClientIp(REAL, SECRET_A, NOW) })
    const next = jest.fn()
    clientIpMiddleware(r, res(), next)
    expect(next).toHaveBeenCalled()
    __setClockForTest(() => (NOW + 61) * 1000) // body đọc xong 61 giây sau
    expect(resolveClientIp(r).ip).toBe(REAL)
  })
})

describe('dải cảnh báo quản trị', () => {
  const ORIGINAL = process.env.TRUSTED_PROXY
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TRUSTED_PROXY
    else process.env.TRUSTED_PROXY = ORIGINAL
  })

  it('có sự kiện không tin được trong 24 giờ ⇒ cảnh báo; request tin được xen giữa KHÔNG tắt (không nhấp nháy)', () => {
    delete process.env.TRUSTED_PROXY
    expect(clientIpWarning()).toBeNull()
    resolveClientIp(req(PUBLIC_PEER))
    expect(clientIpWarning()).toBeNull()
    resolveClientIp(req('127.0.0.1', { 'x-real-ip': REAL }))
    expect(clientIpWarning()).toMatch(/TRUSTED_PROXY/)
    resolveClientIp(req(PUBLIC_PEER))
    expect(clientIpWarning()).toMatch(/loopback/)
  })

  it('cảnh báo tự tắt sau 24 giờ không gặp lại', () => {
    delete process.env.TRUSTED_PROXY
    resolveClientIp(req('127.0.0.1'))
    __setClockForTest(() => (NOW + 25 * 3600) * 1000)
    expect(clientIpWarning()).toBeNull()
  })
})

describe('kiểm lúc khởi động', () => {
  it('cờ cũ không kèm TRUSTED_PROXY ⇒ không lên, thông báo liệt kê giá trị theo cách triển khai', () => {
    for (const flag of ['ATTENDANCE_TRUST_CF_IP', 'LOGIN_WIFI_TRUST_CF_IP', 'ATTENDANCE_TRUST_PROXY_HEADERS', 'LOGIN_WIFI_TRUST_PROXY_HEADERS']) {
      const p = clientIpStartupProblems({ [flag]: 'true' } as NodeJS.ProcessEnv)
      expect(p).toHaveLength(1)
      expect(p[0]).toContain(flag)
      expect(p[0]).toContain('cidr:127.0.0.1/32')
      expect(p[0]).toContain('cloudflare-tunnel')
    }
  })

  it('cờ cũ = false / 1 / yes (bản cũ chỉ bật khi đúng "true"), hoặc đã có TRUSTED_PROXY ⇒ lên, chỉ cảnh báo', () => {
    expect(clientIpStartupProblems({ ATTENDANCE_TRUST_CF_IP: 'false' } as NodeJS.ProcessEnv)).toEqual([])
    expect(clientIpStartupProblems({ ATTENDANCE_TRUST_CF_IP: '1', LOGIN_WIFI_TRUST_CF_IP: 'yes' } as NodeJS.ProcessEnv)).toEqual([])
    expect(clientIpStartupWarnings({ ATTENDANCE_TRUST_CF_IP: '1' } as NodeJS.ProcessEnv)[0]).toMatch(/ATTENDANCE_TRUST_CF_IP/)
    expect(clientIpStartupWarnings({} as NodeJS.ProcessEnv)).toEqual([])
    expect(clientIpStartupProblems({ ATTENDANCE_TRUST_CF_IP: 'true', TRUSTED_PROXY: 'cloudflare' } as NodeJS.ProcessEnv)).toEqual([])
  })

  it('TRUSTED_PROXY / CLOUDFLARE_IP_RANGES sai ⇒ không lên', () => {
    expect(clientIpStartupProblems({ TRUSTED_PROXY: 'yes' } as NodeJS.ProcessEnv)).toHaveLength(1)
    expect(clientIpStartupProblems({ CLOUDFLARE_IP_RANGES: '1.2.3.4/99' } as NodeJS.ProcessEnv)).toHaveLength(1)
    expect(clientIpStartupProblems({ CLOUDFLARE_IP_RANGES: '192.0.2.0/24, docker-gateway' } as NodeJS.ProcessEnv)[0]).toMatch(/docker-gateway/)
  })

  it('cloudflare-tunnel với địa chỉ nghe không phải loopback ⇒ không lên', () => {
    const e = { TRUSTED_PROXY: 'cloudflare-tunnel' } as NodeJS.ProcessEnv
    expect(tunnelListenProblem('::', e)).toMatch(/không phải loopback/)
    expect(tunnelListenProblem('0.0.0.0', e)).toMatch(/không phải loopback/)
    expect(tunnelListenProblem('172.18.0.3', e)).toMatch(/không phải loopback/)
    expect(tunnelListenProblem('127.0.0.1', e)).toBeNull()
    expect(tunnelListenProblem('::1', e)).toBeNull()
    expect(tunnelListenProblem('0.0.0.0', { TRUSTED_PROXY: 'none' } as NodeJS.ProcessEnv)).toBeNull()
  })
})
