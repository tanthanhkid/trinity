import type { ContactEventSnapshot, DealEventSnapshot, PosOrderEventSnapshot } from './event-catalog'

type Dateish = Date | string | null | undefined
type Numish = bigint | number | string | { toString(): string }

const iso = (d: Dateish): string | null => (d == null ? null : d instanceof Date ? d.toISOString() : String(d))
const str = (v: Numish | null | undefined): string | null => (v == null ? null : v.toString())

interface ContactRowLike {
  id: number
  phone?: string | null
  phone_2?: string | null
  full_name?: string | null
  email?: string | null
  zalo_account?: string | null
  source_id?: number | null
  stage_id?: number | null
  contact_status_id?: number | null
  assigned_to?: number | null
  team_id?: number | null
  created_by_id?: number | null
  project_id?: number | null
  created_at?: Dateish
  updated_at?: Dateish
  deleted_at?: Dateish
}

/** Select Prisma tối thiểu để dựng `ContactEventSnapshot` (dùng chung mọi chỗ ghi khách). */
export const CONTACT_EVENT_SELECT = {
  id: true, phone: true, phone_2: true, full_name: true, email: true, zalo_account: true,
  source_id: true, stage_id: true, contact_status_id: true, assigned_to: true, team_id: true,
  created_by_id: true, project_id: true, created_at: true, updated_at: true, deleted_at: true,
} as const

/** Trường thiếu trong row (select hẹp) → null, KHÔNG bịa giá trị. */
export function snapshotContact(r: ContactRowLike): ContactEventSnapshot {
  return {
    id: r.id,
    phone: r.phone ?? null,
    phone_2: r.phone_2 ?? null,
    full_name: r.full_name ?? null,
    email: r.email ?? null,
    zalo_account: r.zalo_account ?? null,
    source_id: r.source_id ?? null,
    stage_id: r.stage_id ?? null,
    contact_status_id: r.contact_status_id ?? null,
    assigned_to: r.assigned_to ?? null,
    team_id: r.team_id ?? null,
    created_by_id: r.created_by_id ?? null,
    project_id: r.project_id ?? null,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    deleted_at: iso(r.deleted_at),
  }
}

interface DealRowLike {
  id: number
  title: string
  description?: string | null
  note?: string | null
  value?: bigint | number | null
  status: string
  assigned_to: number
  created_by: number
  contact_id?: number | null
  created_at?: Dateish
  updated_at?: Dateish
}

export function snapshotDeal(r: DealRowLike): DealEventSnapshot {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    note: r.note ?? null,
    value: str(r.value),
    status: r.status,
    assigned_to: r.assigned_to,
    created_by: r.created_by,
    contact_id: r.contact_id ?? null,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
}

interface PosOrderRowLike {
  id: number
  code: string
  status: string
  order_type: string
  table_id: number | null
  shift_id: number
  note: string | null
  subtotal: Numish
  discount_type: string
  discount_amount: Numish
  total: Numish
  created_by: number
  paid_by: number | null
  paid_at: Dateish
  created_at: Dateish
  items: Array<{ product_id: number; product_name: string; unit_price: Numish; quantity: number; line_total: Numish }>
  payments: Array<{ method: string; amount: Numish; reference: string | null }>
}

export function snapshotPosOrder(o: PosOrderRowLike): PosOrderEventSnapshot {
  return {
    id: o.id, code: o.code, status: o.status, order_type: o.order_type, table_id: o.table_id,
    shift_id: o.shift_id, note: o.note, subtotal: o.subtotal.toString(), discount_type: o.discount_type,
    discount_amount: o.discount_amount.toString(), total: o.total.toString(), created_by: o.created_by,
    paid_by: o.paid_by, paid_at: iso(o.paid_at), created_at: iso(o.created_at),
    items: o.items.map((i) => ({
      product_id: i.product_id, product_name: i.product_name, unit_price: i.unit_price.toString(),
      quantity: i.quantity, line_total: i.line_total.toString(),
    })),
    payments: o.payments.map((p) => ({ method: p.method, amount: p.amount.toString(), reference: p.reference })),
  }
}
