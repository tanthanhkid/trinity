/**
 * Xuất bảng route của monolith ra `server/contracts/routes.json` (hợp đồng đóng băng, docs/rust/PLAN.md mục 6.1).
 * Nguồn: metadata decorator của Nest (cùng cách quét với `auditRoutes`) + bảng lenient/strict của
 * `ServiceAwareValidationPipe`. Chạy ở chế độ `--check` thì so với file đã commit (job CI `Contracts`).
 *
 *   pnpm --filter @trinity/monolith contracts:routes [--check]
 *
 * Cột nào không suy ra được từ decorator (`cached`, `safe_for_shadow`, `min_samples`, `deprecated`) lấy từ bảng tay
 * ở đầu file này, mỗi dòng có lý do; sửa tay rồi chạy lại lệnh.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { RequestMethod, type INestApplication } from '@nestjs/common'
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  RESPONSE_PASSTHROUGH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants'
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum'
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core'
import { RBAC_META, type AccessMeta } from '@trinity/rbac-nest'

import { ORG_FEATURE_META } from '../../../../services/crm/src/usage/org-feature.guard'
import { LENIENT_PREFIXES } from '../service-aware-validation.pipe'
import { createContractApp, failOnError, repoRoot, runExport, sortKeys } from './common'

// class-transformer không khai báo kiểu cho `cjs/storage`; ta chỉ cần đọc kho metadata nội bộ của nó.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const getStorage = (): unknown => require('class-transformer/cjs/storage').defaultMetadataStorage

const GLOBAL_PREFIX = '/api/v1'
/** `app.useBodyParser('json'|'urlencoded', { limit: '5mb' })` ở `configureApp`. */
const BODY_LIMIT_BYTES = 5 * 1024 * 1024
/** Số mẫu shadow tối thiểu mỗi route (PLAN mục 4.14). */
const DEFAULT_MIN_SAMPLES = 50

/**
 * Route có cache đọc phía Node (response có thể cũ tới TTL): chỉ so hình dạng trên lưu lượng thật (PLAN mục 4.14).
 * Khoá `<tệp controller từ gốc repo>#<Class>.<handler>` (tên lớp trùng giữa các service, ví dụ `ReportsController`). Nguồn: ghi chú cache ở service tương ứng.
 */
const CACHED_HANDLERS = new Set([
  'services/crm/src/reports/dashboard-overview.controller.ts#DashboardOverviewController.getOverview', // dashboard-overview.service.ts: Redis 300 giây theo user
  'services/crm/src/reports/dashboard-trend.controller.ts#DashboardTrendController.getDashboardTrend14d', // dashboard-trend.service.ts: Redis 120 giây
  'services/crm/src/reports/reports.controller.ts#ReportsController.getDashboardStatsToday', // dashboard-stats-today.service.ts: Redis, thẻ số "hôm nay"
  'services/notification/src/notifications/notifications.controller.ts#NotificationsController.getUnreadCount', // notifications.service.ts: unreadCache trong RAM
  'services/crm/src/contacts/contacts.controller.ts#ContactsController.findAll', // contacts.service.ts: cache COUNT(*) 60 giây
  'services/crm/src/stale-work/stale-work.controller.ts#StaleWorkController.summary', // stale-work.service.ts: scanCache 60 giây
])

/**
 * GET đã rà là thuần đọc: bật shadow (K28). Mặc định `false`; chỉ thêm sau khi rà mã từng handler.
 * Rỗng ở C02: danh sách mở ra dần ở issue shadow, không đoán từ phương thức HTTP (PLAN mục 1.10: có GET ghi DB hoặc gọi Graph).
 */
/**
 * Route thanh toán sẽ gỡ ở G07b (Rust không viết lại, Node vẫn phục vụ tới lúc đó): `deprecated: true`.
 * Khoá `<Controller>#<METHOD> <đường dẫn>`; G07b/G08 gỡ route thì xoá dòng tương ứng cùng lúc chạy lại lệnh.
 */
const DEPRECATED_ROUTES = new Set<string>(
  [
    'PUT /connectors/sepay',
    'PUT /connectors/vnpay',
    'PUT /connectors/momo',
    'GET /pay/:code/vnpay',
    'GET /pay/:code/momo',
    'GET /connectors/vnpay/ipn',
    'GET /pay/vnpay/return',
    'POST /connectors/momo/ipn',
    'GET /pay/momo/return',
    'POST /connectors/sepay/webhook',
    'GET /payments',
    'POST /payments',
    'GET /payments/:id',
    'POST /payments/:id/cancel',
  ].map((r) => `ConnectorsController#${r.replace(/ \//, ' /api/v1/')}`),
)

const SAFE_FOR_SHADOW = new Set<string>([])

/** Quyền đổi hình dạng response (không phải cổng): quét `<perm>` ở mã của thư mục controller, ngoài dòng `@Can`/`@CanAny`. */
const SHAPE_PERMISSION_RE = /'((?:[a-z_]+)\.phone_full)'/g

const PRIMITIVES = new Set<unknown>([String, Number, Boolean])
const RES_TYPE = RouteParamtypes.RESPONSE
const FILE_TYPES = new Set<number>([RouteParamtypes.FILE, RouteParamtypes.FILES])

export interface RouteRow {
  method: string
  path: string
  access: 'can' | 'auth' | 'public' | 'internal'
  permissions: string[]
  permission_mode: 'all' | 'any' | null
  validation: 'strict' | 'lenient'
  body_limit_bytes: number | null
  /** `null` khi handler tự đặt mã (`@Res()` trần, không `@HttpCode`). */
  status_ok: number | null
  org_feature: string | null
  guards: string[]
  interceptors: string[]
  raw_response: boolean
  res_passthrough: boolean
  headers: Record<string, string>
  param_pipes: string[]
  transforms: string[]
  upload: 'file' | 'files' | 'interceptor' | null
  shape_permissions: string[]
  cached: boolean
  safe_for_shadow: boolean
  min_samples: number
  deprecated: boolean
  controller: string
  handler: string
}

function joinPath(...parts: (string | undefined)[]): string {
  const joined = parts
    .filter((p): p is string => Boolean(p))
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
  return `/${joined}`
}

/** Tên class; mixin của Nest (`FileInterceptor`, `mixin()`) mang tên ngẫu nhiên mỗi lần chạy nên gộp thành `Mixin`. */
const rawName = (x: unknown): string =>
  typeof x === 'function' ? x.name : x && typeof x === 'object' ? (x as object).constructor.name : String(x)
const nameOf = (x: unknown): string => {
  const n = rawName(x)
  return /^[0-9a-f]{12,}$/i.test(n) ? 'Mixin' : n
}

const asArray = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x])

/**
 * Tệp nguồn của từng class controller, tìm theo định danh class trong `require.cache` (tên lớp trùng giữa các service).
 * Đường dẫn bản dịch `dist/<đường dẫn nguồn>.js` đổi về `<gốc repo>/<đường dẫn nguồn>.ts`.
 */
function indexControllerFiles(root: string): Map<Function, string> {
  const out = new Map<Function, string>()
  for (const [file, mod] of Object.entries(require.cache)) {
    if (!/\.controller\.js$/.test(file) || !mod) continue
    const m = /\/dist\/(.+)\.js$/.exec(file)
    const rel = m ? `${m[1]}.ts` : path.relative(root, file).replace(/\.js$/, '.ts')
    for (const v of Object.values(mod.exports as Record<string, unknown>)) if (typeof v === 'function') out.set(v, rel)
  }
  return out
}

function shapePermissionsOfDir(dir: string, cache: Map<string, string[]>): string[] {
  const hit = cache.get(dir)
  if (hit) return hit
  const found = new Set<string>()
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name !== '__tests__') walk(p)
      } else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) {
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          if (/@Can(Any)?\(/.test(line)) continue
          for (const m of line.matchAll(SHAPE_PERMISSION_RE)) found.add(m[1])
        }
      }
    }
  }
  walk(dir)
  const res = [...found].sort()
  cache.set(dir, res)
  return res
}

type Storage = {
  _transformMetadatas?: Map<Function, Map<string, unknown[]>>
  _typeMetadatas?: Map<Function, Map<string, { typeFunction?: () => unknown }>>
}

/** Các trường DTO có `@Transform`/`@Type` (đệ quy qua `@Type(() => Dto)`), dạng `Dto.truong`. */
function dtoTransforms(root: Function | undefined, seen = new Set<Function>()): string[] {
  if (!root || typeof root !== 'function' || seen.has(root) || [String, Number, Boolean, Object, Array, Date].includes(root as never)) return []
  seen.add(root)
  const st = getStorage() as Storage
  const out: string[] = []
  const chain: Function[] = []
  for (let c: Function | null = root; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) chain.push(c)
  for (const c of chain) {
    for (const [prop, list] of st._transformMetadatas?.get(c) ?? []) {
      if (list.length) out.push(`${root.name}.${prop}:@Transform`)
    }
    for (const [prop, meta] of st._typeMetadatas?.get(c) ?? []) {
      out.push(`${root.name}.${prop}:@Type`)
      try {
        const t = meta.typeFunction?.()
        if (typeof t === 'function') out.push(...dtoTransforms(t, seen))
      } catch {
        /* typeFunction phụ thuộc ngữ cảnh: bỏ qua */
      }
    }
  }
  return [...new Set(out)].sort()
}

export function collectRoutes(app: INestApplication): RouteRow[] {
  const discovery = app.get(DiscoveryService)
  const scanner = app.get(MetadataScanner)
  const reflector = app.get(Reflector)
  const root = repoRoot()
  const files = indexControllerFiles(root)
  const shapeCache = new Map<string, string[]>()
  const rows: RouteRow[] = []

  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper
    if (!instance || !metatype) continue
    const proto = Object.getPrototypeOf(instance)
    const classPaths = asArray<string>(Reflect.getMetadata(PATH_METADATA, metatype)).map((p) => p ?? '')
    if (classPaths.length === 0) classPaths.push('')

    for (const handler of scanner.getAllMethodNames(proto)) {
      const ref = proto[handler]
      const methodPathMeta = Reflect.getMetadata(PATH_METADATA, ref)
      if (methodPathMeta === undefined) continue
      const requestMethod: RequestMethod = Reflect.getMetadata(METHOD_METADATA, ref)
      const method = RequestMethod[requestMethod]
      const access = reflector.getAllAndOverride<AccessMeta | undefined>(RBAC_META, [ref, metatype])
      if (!access) throw new Error(`${metatype.name}.${handler} thiếu metadata quyền`)

      const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, metatype, handler) ?? {}) as Record<
        string,
        { index: number; data?: unknown; pipes?: unknown[] }
      >
      const types = (Reflect.getMetadata('design:paramtypes', proto, handler) ?? []) as Function[]
      let rawResponse = false
      // Nest 10: `@Res({ passthrough: true })` ghi cờ lên constructor của controller, theo tên method.
      const passthrough = Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, metatype, handler) === true
      let upload: RouteRow['upload'] = null
      const paramPipes: string[] = []
      const transforms: string[] = []
      for (const [key, a] of Object.entries(args)) {
        const type = Number(key.split(':')[0])
        if (type === RES_TYPE) rawResponse = true
        if (FILE_TYPES.has(type)) upload = type === RouteParamtypes.FILE ? 'file' : 'files'
        const label =
          type === RouteParamtypes.BODY ? 'body' : type === RouteParamtypes.QUERY ? 'query' : type === RouteParamtypes.PARAM ? 'param' : null
        if (label) {
          const slot = typeof a.data === 'string' ? `${label}.${a.data}` : label
          for (const p of a.pipes ?? []) paramPipes.push(`${slot}:${nameOf(p)}`)
          const t = types[a.index]
          if (PRIMITIVES.has(t)) {
            // Không có pipe: ValidationPipe toàn cục (`transform: true`) ép theo kiểu khai báo; Rust phải ép như vậy.
            if (!(a.pipes ?? []).length) transforms.push(`${slot}:${t.name}`)
          } else if (label !== 'param') transforms.push(...dtoTransforms(t))
        }
      }

      const guards = [
        ...asArray<unknown>(Reflect.getMetadata(GUARDS_METADATA, metatype)),
        ...asArray<unknown>(Reflect.getMetadata(GUARDS_METADATA, ref)),
      ].map(nameOf)
      const rawInterceptors = [
        ...asArray<unknown>(Reflect.getMetadata(INTERCEPTORS_METADATA, metatype)),
        ...asArray<unknown>(Reflect.getMetadata(INTERCEPTORS_METADATA, ref)),
      ]
      // Xét tên lớp gốc trước khi gộp mixin ngẫu nhiên thành `Mixin`.
      if (!upload && rawInterceptors.some((x) => /file|upload|selfie/i.test(rawName(x)))) upload = 'interceptor'
      const interceptors = rawInterceptors.map(nameOf)

      const code = Reflect.getMetadata(HTTP_CODE_METADATA, ref) as number | undefined
      const headersMeta = (Reflect.getMetadata(HEADERS_METADATA, ref) ?? []) as { name: string; value: string }[]
      const orgFeature = reflector.getAllAndOverride<string | undefined>(ORG_FEATURE_META, [ref, metatype]) ?? null
      const file = files.get(metatype)
      if (!file) throw new Error(`không tìm thấy tệp nguồn của ${metatype.name}`)
      const dir = path.join(root, path.dirname(file))
      const shape = access.kind === 'public' || access.kind === 'internal' || !dir ? [] : shapePermissionsOfDir(dir, shapeCache)
      const own = new Set(access.kind === 'can' ? access.permissions : [])
      const handlerKey = `${file}#${metatype.name}.${handler}`

      for (const cp of classPaths) {
        for (const mp of asArray<string>(methodPathMeta)) {
          const p = joinPath(GLOBAL_PREFIX, cp, mp)
          const deprecated = DEPRECATED_ROUTES.has(`${metatype.name}#${method} ${p}`)
          rows.push({
            method,
            path: p,
            access: access.kind,
            permissions: access.kind === 'can' ? [...access.permissions] : [],
            permission_mode: access.kind === 'can' ? access.mode : null,
            validation: LENIENT_PREFIXES.some((x) => p.startsWith(x)) ? 'lenient' : 'strict',
            body_limit_bytes: upload ? null : BODY_LIMIT_BYTES,
            // `@Res()` không passthrough và không `@HttpCode`: handler tự đặt mã, hợp đồng không cố định mã thành công.
            status_ok: code ?? (rawResponse && !passthrough ? null : requestMethod === RequestMethod.POST ? 201 : 200),
            org_feature: orgFeature,
            guards,
            interceptors,
            raw_response: rawResponse,
            res_passthrough: passthrough,
            headers: Object.fromEntries(headersMeta.map((h) => [h.name, h.value])),
            param_pipes: paramPipes.sort(),
            transforms: [...new Set(transforms)].sort(),
            upload,
            shape_permissions: shape.filter((s) => !own.has(s as never)),
            cached: CACHED_HANDLERS.has(handlerKey),
            safe_for_shadow: SAFE_FOR_SHADOW.has(`${method} ${p}`),
            min_samples: DEFAULT_MIN_SAMPLES,
            deprecated,
            controller: metatype.name,
            handler,
          })
        }
      }
    }
  }
  rows.sort((a, b) => (a.path === b.path ? (a.method < b.method ? -1 : a.method > b.method ? 1 : 0) : a.path < b.path ? -1 : 1))
  return rows
}

/**
 * Số dòng phải bằng số route Express thật sự đăng ký (sau `app.init()`): bắt route mà quét metadata bỏ sót (hoặc thừa).
 * `init` chạy với `PrismaService.onModuleInit` tắt, nên không cần DB.
 */
async function assertMatchesRegisteredRoutes(app: INestApplication, rows: RouteRow[]): Promise<void> {
  const { PrismaService } = await import('@trinity/prisma')
  PrismaService.prototype.onModuleInit = async () => undefined
  await app.init()
  const inst = app.getHttpAdapter().getInstance() as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } }
  const stack = ((inst._router ?? inst.router)?.stack ?? []) as { route?: { path: string; methods: Record<string, boolean> } }[]
  const registered: string[] = []
  for (const l of stack) {
    if (l.route) for (const m of Object.keys(l.route.methods)) registered.push(`${m.toUpperCase()} ${l.route.path}`)
  }
  const mine = rows.map((r) => `${r.method} ${r.path}`)
  const diff = (a: string[], b: string[]): string[] => {
    const left = new Map<string, number>()
    for (const x of b) left.set(x, (left.get(x) ?? 0) + 1)
    return a.filter((x) => {
      const n = left.get(x) ?? 0
      if (n > 0) left.set(x, n - 1)
      return n === 0
    })
  }
  const missing = diff(registered, mine)
  const extra = diff(mine, registered)
  if (missing.length || extra.length) {
    throw new Error(`routes.json lệch route đã đăng ký (${rows.length} dòng, ${registered.length} route). Thiếu: ${missing.join(', ')}. Thừa: ${extra.join(', ')}`)
  }
}

async function build(): Promise<string> {
  const app = await createContractApp()
  try {
    const rows = collectRoutes(app)
    await assertMatchesRegisteredRoutes(app, rows)
    return `${JSON.stringify(sortKeys({ routes: rows }), null, 2)}\n`
  } finally {
    await app.close().catch(() => undefined)
  }
}

if (require.main === module) failOnError(runExport('routes.json', 'contracts:routes', build))
