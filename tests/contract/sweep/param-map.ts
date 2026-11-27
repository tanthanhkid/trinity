/**
 * Ánh xạ tham số đường dẫn của route GET → nguồn id lấy từ DB bản sao (X13).
 *
 * Quy tắc xét theo thứ tự, khớp đầu tiên thắng: (mẫu đường dẫn bỏ tiền tố `/api/v1`, tên tham số). SQL là hằng số trong
 * file này (tên bảng/cột không bao giờ ghép từ routes.json hay từ response) và chỉ SELECT một cột. Bảng/cột đã đối chiếu
 * `server/contracts/schema.sql`; cột nào chưa chắc ghi chú bên cạnh. Route không có quy tắc được báo `no_sampler` trong báo cáo
 * (không đoán id) để người quét bổ sung quy tắc.
 */
export type ParamSource = { sql: string } | { values: readonly string[] }

export interface ParamRule {
  /** Khớp đường dẫn (không gồm `/api/v1`, tham số viết dạng `:name`, đã bỏ phần regex `(\d+)`). */
  route: RegExp
  param: string
  source: ParamSource
}

const ids = (table: string, col = 'id'): ParamSource => ({ sql: `SELECT ${col} AS v FROM ${table} ORDER BY id DESC LIMIT $1` })

export const PARAM_RULES: readonly ParamRule[] = [
  { route: /^\/api-keys\//, param: 'id', source: ids('api_keys') },
  { route: /^\/briefings\//, param: 'id', source: ids('briefings') },
  { route: /^\/contacts\/:contactId\//, param: 'contactId', source: ids('contacts') },
  { route: /^\/contacts\/:id/, param: 'id', source: ids('contacts') },
  // id có thể thuộc đối tượng khác khoá: cả hai bên cùng 404, vẫn là một mẫu so.
  { route: /^\/custom-objects\/:key\/records\/:id/, param: 'id', source: ids('custom_records') },
  { route: /^\/custom-objects\/:key/, param: 'key', source: ids('custom_objects', 'key') },
  { route: /^\/custom-objects\/:key\/views\/:view/, param: 'view', source: ids('custom_views') }, // chưa chắc :view là id hay khoá
  { route: /^\/deals\//, param: 'id', source: ids('deals') },
  { route: /^\/employees\//, param: 'id', source: ids('employees') },
  { route: /^\/facebook\/broadcasts\//, param: 'id', source: ids('facebook_broadcasts') },
  { route: /^\/facebook\/conversations\//, param: 'id', source: ids('facebook_conversations') },
  { route: /^\/facebook\/flows\//, param: 'id', source: ids('facebook_flows') },
  { route: /^\/facebook\/go\//, param: 'code', source: ids('facebook_chat_links', 'code') }, // chưa chắc cột `code`
  { route: /^\/integrations\/ai-actions\//, param: 'id', source: ids('ai_action_drafts') },
  { route: /^\/integrations\/webhooks\/endpoints\//, param: 'id', source: ids('webhook_endpoints') },
  { route: /^\/integrations\/webhooks\/inbound-sources\//, param: 'id', source: ids('webhook_inbound_sources') },
  { route: /^\/interactions\/comments\//, param: 'id', source: ids('newsfeed_post_comments') }, // chưa chắc bảng bình luận tương tác
  { route: /^\/kanban\/boards\//, param: 'id', source: ids('kanban_boards') },
  { route: /^\/kanban\/cards\/:cardId\//, param: 'cardId', source: ids('kanban_cards') },
  { route: /^\/kanban\/cards\//, param: 'id', source: ids('kanban_cards') },
  { route: /^\/management\/attendance\/:id\/proof\/:slot/, param: 'slot', source: { values: ['in', 'out'] } }, // chưa chắc tên slot
  { route: /^\/management\/attendance\//, param: 'id', source: ids('attendance_records') },
  { route: /^\/management\/contracts\/templates\//, param: 'tid', source: ids('contract_templates') },
  { route: /^\/management\/contracts\//, param: 'id', source: ids('employee_contracts') },
  { route: /^\/management\/employees\//, param: 'id', source: ids('employees') },
  { route: /^\/management\/job-titles\//, param: 'id', source: ids('job_titles') },
  { route: /^\/management\/teams\//, param: 'id', source: ids('teams') },
  { route: /^\/newsfeed\/:id\/images\/:index/, param: 'index', source: { values: ['0', '1', '2'] } },
  { route: /^\/newsfeed\//, param: 'id', source: ids('newsfeed_posts') },
  { route: /^\/pay\/:code\//, param: 'code', source: ids('store_orders', 'code') }, // chưa chắc mã thanh toán nằm ở store_orders
  { route: /^\/payslips\//, param: 'id', source: ids('payslips') },
  { route: /^\/pos\/orders\//, param: 'id', source: ids('pos_orders') },
  { route: /^\/pos\/shifts\//, param: 'id', source: ids('pos_shifts') },
  { route: /^\/product-categories\/:categoryId\//, param: 'categoryId', source: ids('product_categories') },
  { route: /^\/product-categories\//, param: 'id', source: ids('product_categories') },
  { route: /^\/products\//, param: 'id', source: ids('products') },
  { route: /^\/projects\//, param: 'id', source: ids('projects') },
  { route: /^\/refs\/:type\/:id\//, param: 'id', source: ids('contacts') }, // id lấy từ khách hàng; loại khác cùng 404 ở hai bên
  { route: /^\/refs\/:type\//, param: 'type', source: { values: ['contact', 'deal', 'project', 'employee'] } }, // chưa chắc tập loại
  { route: /^\/reports\/custom\//, param: 'id', source: ids('custom_views') }, // chưa chắc bảng báo cáo tuỳ biến
  { route: /^\/roles\//, param: 'id', source: ids('roles') },
  { route: /^\/salary-rules\//, param: 'id', source: ids('salary_rules') },
  { route: /^\/social\/drafts\//, param: 'id', source: ids('social_drafts') },
  { route: /^\/social\/media\//, param: 'id', source: ids('social_media_assets') },
  { route: /^\/social\/posts\//, param: 'id', source: ids('social_posts') },
  { route: /^\/social\/oauth\/callback\//, param: 'network', source: { values: ['facebook', 'zalo'] } },
  { route: /^\/store\/public\/:slug\/orders\//, param: 'code', source: ids('store_orders', 'code') },
  { route: /^\/store\/public\//, param: 'slug', source: ids('pos_settings', 'id') }, // chưa chắc slug ở đâu: người quét kiểm
  { route: /^\/templates\//, param: 'id', source: ids('notification_templates') }, // chưa chắc :id thuộc mẫu nào
  { route: /^\/users\//, param: 'id', source: ids('users') },
  { route: /^\/zalo-oa\/threads\//, param: 'id', source: ids('zalo_oa_threads') },
  { route: /^\/connectors\/:provider\//, param: 'provider', source: { values: ['facebook', 'zalo', 'google'] } },
]

/** Bỏ phần regex của Nest (`:id(\d+)`) và tiền tố `/api/v1`. */
export function normalizeRoutePath(p: string): string {
  return p.replace(/^\/api\/v1/, '').replace(/(:\w+)\([^)]*\)/g, '$1')
}

export function routeParams(p: string): string[] {
  return [...normalizeRoutePath(p).matchAll(/:(\w+)/g)].map((m) => m[1] as string)
}

export function findRule(routePath: string, param: string): ParamRule | undefined {
  const n = normalizeRoutePath(routePath)
  return PARAM_RULES.find((r) => r.param === param && r.route.test(n))
}

/** Tập (tham số → nguồn) cho một route; `missing` là các tham số chưa có quy tắc. */
export function resolveParams(routePath: string): { sources: Map<string, ParamSource>; missing: string[] } {
  const sources = new Map<string, ParamSource>()
  const missing: string[] = []
  for (const p of routeParams(routePath)) {
    const r = findRule(routePath, p)
    if (r) sources.set(p, r.source)
    else missing.push(p)
  }
  return { sources, missing }
}

/** Mọi giá trị đưa vào URL phải đơn giản (chữ, số, gạch): không bao giờ chèn ký tự đặc biệt từ DB vào đường dẫn. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Dựng danh sách đường dẫn thật cho tối đa `count` lần gọi: xoay vòng giá trị từng tham số (tích Descartes, cắt ở `count`).
 * Trả `[]` nếu thiếu giá trị cho tham số nào (route không có mẫu).
 */
export function expandPaths(routePath: string, values: Map<string, string[]>, count: number): string[] {
  const params = routeParams(routePath)
  const tpl = normalizeRoutePath(routePath)
  if (params.length === 0) return [tpl]
  const lists = params.map((p) => (values.get(p) ?? []).filter((v) => SAFE_SEGMENT.test(v)))
  if (lists.some((l) => l.length === 0)) return []
  const total = lists.reduce((a, l) => a * l.length, 1)
  const out: string[] = []
  for (let i = 0; i < Math.min(count, total); i++) {
    let rest = i
    let path = tpl
    params.forEach((p, k) => {
      const l = lists[k] as string[]
      path = path.replace(new RegExp(`:${p}(?![A-Za-z0-9_])`), encodeURIComponent(l[rest % l.length] as string))
      rest = Math.floor(rest / l.length)
    })
    out.push(path)
  }
  return out
}
