/**
 * Catalog sự kiện nghiệp vụ cho bus tích hợp — NGUỒN DUY NHẤT.
 * Webhook ra, MCP và UI chọn sự kiện cùng đọc từ đây; thêm sự kiện = thêm 1 dòng
 * vào `INTEGRATION_EVENT_META` + 1 dòng vào `IntegrationEventMap`.
 *
 * Payload là dữ liệu THÔ (kể cả SĐT đầy đủ): việc che SĐT làm ở bước GỬI theo quyền
 * `contacts.phone_full` của người tạo endpoint — KHÔNG che ở đây. Vì thế payload CHỈ chứa trường lõi
 * (không địa chỉ/custom_fields): bên nhận webhook không được thấy nhiều hơn mức cần.
 */

export const INTEGRATION_EVENT_META = {
  'contact.created': { resource: 'contact', label: 'Tạo khách hàng' },
  'contact.updated': { resource: 'contact', label: 'Sửa khách hàng' },
  'contact.stage_changed': { resource: 'contact', label: 'Đổi giai đoạn khách hàng' },
  'contact.assigned': { resource: 'contact', label: 'Gán / chuyển khách cho người khác' },
  'contact.deleted': { resource: 'contact', label: 'Xoá khách hàng' },
  'deal.created': { resource: 'deal', label: 'Tạo deal' },
  'deal.stage_changed': { resource: 'deal', label: 'Deal đổi trạng thái' },
  'deal.won': { resource: 'deal', label: 'Deal chốt thành công' },
  'deal.lost': { resource: 'deal', label: 'Deal thất bại' },
  'pos.order.completed': { resource: 'pos_order', label: 'Đơn POS hoàn tất (đã thu tiền)' },
  'custom_record.created': { resource: 'custom_record', label: 'Tạo bản ghi tính năng tuỳ biến' },
  'custom_record.updated': { resource: 'custom_record', label: 'Sửa bản ghi tính năng tuỳ biến' },
  'custom_record.deleted': { resource: 'custom_record', label: 'Xoá bản ghi tính năng tuỳ biến' },
  'zalo_oa.message_received': { resource: 'zalo_oa_thread', label: 'Zalo OA: khách nhắn tới' },
  'zalo_oa.message_sent': { resource: 'zalo_oa_thread', label: 'Zalo OA: gửi tin tư vấn / ZNS' },
  'messenger.message_received': { resource: 'messenger_conversation', label: 'Messenger: khách nhắn Fanpage' },
  'messenger.message_sent': { resource: 'messenger_conversation', label: 'Messenger: Fanpage gửi tin (nhân viên, kịch bản, gửi hàng loạt)' },
  'messenger.broadcast_finished': { resource: 'messenger_broadcast', label: 'Messenger: lượt gửi hàng loạt đã xong' },
  'facebook.comment_received': { resource: 'facebook_comment', label: 'Fanpage: có bình luận mới' },
  'social_post.published': { resource: 'social_post', label: 'Đăng bài: đã lên kênh' },
  'social_post.failed': { resource: 'social_post', label: 'Đăng bài: đăng lỗi' },
  'payment.received': { resource: 'payment_intent', label: 'Thanh toán: đã nhận tiền (SePay, VNPay, MoMo)' },
  'store_order.created': { resource: 'store_order', label: 'Trang bán hàng: có đơn mới' },
} as const satisfies Record<string, { resource: string; label: string }>

export type IntegrationEventType = keyof typeof INTEGRATION_EVENT_META
export const INTEGRATION_EVENT_TYPES = Object.keys(INTEGRATION_EVENT_META) as IntegrationEventType[]

export function isIntegrationEventType(x: string): x is IntegrationEventType {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_EVENT_META, x)
}

/** Ảnh chụp khách hàng đưa vào sự kiện — chỉ trường lõi (xem ghi chú đầu file). */
export interface ContactEventSnapshot {
  id: number
  phone: string | null
  phone_2: string | null
  full_name: string | null
  email: string | null
  zalo_account: string | null
  source_id: number | null
  stage_id: number | null
  contact_status_id: number | null
  assigned_to: number | null
  team_id: number | null
  created_by_id: number | null
  project_id: number | null
  created_at: string | null
  updated_at: string | null
  deleted_at: string | null
}

export interface DealEventSnapshot {
  id: number
  title: string
  description: string | null
  note: string | null
  /** VND — chuỗi (BigInt không an toàn trong JSON). */
  value: string | null
  status: string
  assigned_to: number
  created_by: number
  contact_id: number | null
  created_at: string | null
  updated_at: string | null
}

export interface PosOrderEventSnapshot {
  id: number
  code: string
  status: string
  order_type: string
  table_id: number | null
  shift_id: number
  note: string | null
  subtotal: string
  discount_type: string
  discount_amount: string
  total: string
  created_by: number
  paid_by: number | null
  paid_at: string | null
  created_at: string | null
  items: Array<{ product_id: number; product_name: string; unit_price: string; quantity: number; line_total: string }>
  payments: Array<{ method: string; amount: string; reference: string | null }>
}

/**
 * Bản ghi thực thể tuỳ biến. `data` là THÔ (kể cả SĐT ở các trường kiểu phone, liệt kê trong `phone_fields`);
 * che SĐT + lọc theo phạm vi/vai trò làm ở bước GỬI (`webhook-payload.ts`). Không gồm trường công thức (tính lúc đọc).
 */
export interface CustomRecordEventSnapshot {
  id: number
  title: string | null
  owner_id: number | null
  created_by: number | null
  data: Record<string, unknown>
  phone_fields: string[]
  created_at: string | null
  updated_at: string | null
}

export interface CustomObjectEventRef {
  id: number
  key: string
  label: string
  is_active: boolean
  visible_role_ids: number[]
}

/** Sự kiện Zalo OA: CHỈ định danh + loại tin, KHÔNG có nội dung tin/SĐT (người nhận webhook tự tra qua API nếu có quyền). */
export interface ZaloOaEventRef {
  thread_id: number
  contact_id: number | null
  /** Người phụ trách khách đã ghép (để lọc theo phạm vi xem). */
  contact_assigned_to: number | null
  kind: 'text' | 'attachment' | 'zns'
}

/** Sự kiện Messenger: như Zalo OA — CHỈ định danh, KHÔNG nội dung tin/SĐT. */
export interface MessengerEventRef {
  conversation_id: number
  page_id: string
  contact_id: number | null
  contact_assigned_to: number | null
  /** Ai/cái gì tạo tin: khách, nhân viên trong Trinity, Fanpage (trả lời ngoài Trinity), kịch bản, gửi hàng loạt, nhắn riêng từ bình luận. */
  origin: 'customer' | 'agent' | 'page' | 'flow' | 'broadcast' | 'comment_reply'
}

/** Bình luận mới trên bài của Fanpage — định danh + kết quả luật tự trả lời, không nội dung. */
export interface FacebookCommentEventRef {
  comment_id: number
  page_id: string
  post_id: string
  contact_id: number | null
  contact_assigned_to: number | null
  /** received = không luật nào khớp; done/failed/test/skipped = kết quả luật tự trả lời. */
  auto_reply_status: string
}

export interface MessengerBroadcastEventRef {
  broadcast_id: number
  page_id: string
  name: string
  status: string
  total: number
  sent: number
  failed: number
  skipped: number
}

/** Một lượt đăng bài lên một kênh (bài đăng nhiều kênh ⇒ mỗi kênh một sự kiện). */
export interface SocialPostEventRef {
  post_id: number
  target_id: number
  network: string
  account_id: number
  url: string | null
  error: string | null
}

/** Đơn mới từ trang bán hàng online. `contact_assigned_to` = người phụ trách khách đã ghép (quyết định ai nhận webhook). */
export interface StoreOrderEventSnapshot {
  id: number
  code: string
  status: string
  customer_name: string
  customer_phone: string
  customer_address: string | null
  note: string | null
  items: Array<{ product_id: number; name: string; quantity: number; price: number }>
  total: number
  payment_method: string
  contact_id: number | null
  contact_assigned_to: number | null
  created_at: string
}

/** Yêu cầu thanh toán đã nhận đủ tiền — chỉ định danh + số tiền, không nội dung chuyển khoản. */
export interface PaymentEventRef {
  payment_intent_id: number
  code: string
  amount: number
  paid_amount: number
  paid_via: string
  source_type: string
  source_id: number | null
  contact_id: number | null
  paid_at: string
}

/** Payload từng loại sự kiện. `origin` = kênh tạo (vd 'public_api', 'import', 'webhook') khi có. */
export interface IntegrationEventMap {
  'contact.created': { contact: ContactEventSnapshot; origin?: string }
  'contact.updated': { contact: ContactEventSnapshot; changed_fields: string[] }
  'contact.stage_changed': { contact: ContactEventSnapshot; from_stage_id: number | null; to_stage_id: number | null }
  'contact.assigned': { contact: ContactEventSnapshot; from_user_id: number | null; to_user_id: number | null; reason?: string | null }
  'contact.deleted': { contact: ContactEventSnapshot }
  'deal.created': { deal: DealEventSnapshot }
  'deal.stage_changed': { deal: DealEventSnapshot; from_status: string; to_status: string }
  'deal.won': { deal: DealEventSnapshot }
  'deal.lost': { deal: DealEventSnapshot }
  'pos.order.completed': { order: PosOrderEventSnapshot }
  'custom_record.created': { object: CustomObjectEventRef; record: CustomRecordEventSnapshot }
  'custom_record.updated': { object: CustomObjectEventRef; record: CustomRecordEventSnapshot; changed_fields: string[] }
  'custom_record.deleted': { object: CustomObjectEventRef; record: CustomRecordEventSnapshot }
  'zalo_oa.message_received': ZaloOaEventRef
  'zalo_oa.message_sent': ZaloOaEventRef
  'messenger.message_received': MessengerEventRef
  'messenger.message_sent': MessengerEventRef
  'messenger.broadcast_finished': MessengerBroadcastEventRef
  'facebook.comment_received': FacebookCommentEventRef
  'social_post.published': SocialPostEventRef
  'social_post.failed': SocialPostEventRef
  'payment.received': PaymentEventRef
  'store_order.created': { order: StoreOrderEventSnapshot }
}
