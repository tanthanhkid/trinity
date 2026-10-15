import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { todayVn } from "@/lib/format"
import type {
  CustomFieldDef, CustomLookupItem, CustomNavItem, CustomObjectDef, CustomObjectSummary, CustomRecord,
  CustomRecordData, CustomRecordPage, CustomRelatedGroup, CustomTemplateInfo,
} from "@/types/custom-objects"

/**
 * Thực thể tuỳ biến — React Query. BE là cổng thật (phạm vi, vai trò, SĐT); FE chỉ gọi.
 * Khoá cache gốc `["custom-objects", …]`; mọi thay đổi ĐỊNH NGHĨA làm mới menu + danh sách + định nghĩa.
 */
const ROOT = ["custom-objects"] as const
export const customKeys = {
  nav: [...ROOT, "nav"] as const,
  list: [...ROOT, "list"] as const,
  templates: [...ROOT, "templates"] as const,
  def: (key: string) => [...ROOT, "def", key] as const,
  records: (key: string, params: RecordListParams) => [...ROOT, "records", key, params] as const,
  recordsOf: (key: string) => [...ROOT, "records", key] as const,
  record: (key: string, id: number) => [...ROOT, "record", key, id] as const,
  related: (key: string, id: number) => [...ROOT, "related", key, id] as const,
}

export interface RecordListParams {
  q?: string
  sort?: string
  dir?: "asc" | "desc"
  /** JSON string `{khoá_trường: giá trị}` — dựng bằng `JSON.stringify`. */
  filter?: string
}

const base = (key: string) => `/custom-objects/${encodeURIComponent(key)}`

/** Menu của người dùng hiện tại. `enabled` = có quyền xem dữ liệu (tránh 403 thừa). */
export function useCustomNav(enabled: boolean) {
  return useQuery<CustomNavItem[]>({
    queryKey: customKeys.nav,
    queryFn: async () => (await apiClient.get<CustomNavItem[]>("/custom-objects/nav")).data,
    enabled,
    staleTime: 60_000,
  })
}

export function useCustomObjectList(enabled = true) {
  return useQuery<CustomObjectSummary[]>({
    queryKey: customKeys.list,
    queryFn: async () => (await apiClient.get<CustomObjectSummary[]>("/custom-objects")).data,
    enabled,
  })
}

export function useCustomObjectDef(key: string | undefined, enabled = true) {
  return useQuery<CustomObjectDef>({
    queryKey: customKeys.def(key ?? ""),
    queryFn: async () => (await apiClient.get<CustomObjectDef>(base(key as string))).data,
    enabled: enabled && !!key,
    retry: (count, err) => (err as { response?: { status?: number } })?.response?.status !== 404 && count < 2,
  })
}

function useInvalidateDefinitions() {
  const qc = useQueryClient()
  return (key?: string) => {
    void qc.invalidateQueries({ queryKey: customKeys.nav })
    void qc.invalidateQueries({ queryKey: customKeys.list })
    if (key) void qc.invalidateQueries({ queryKey: customKeys.def(key) })
  }
}

export interface ObjectInput {
  key?: string
  label?: string
  label_plural?: string
  icon?: string | null
  description?: string | null
  show_in_nav?: boolean
  nav_order?: number
  visible_role_ids?: number[]
  is_active?: boolean
  /** Tiền tố mã bản ghi (2–4 chữ in hoa). Đổi ⇒ mã mọi bản ghi đổi theo, mã cũ vẫn tra được. */
  code_prefix?: string
}

export function useCreateCustomObject() {
  const done = useInvalidateDefinitions()
  return useMutation({
    mutationFn: async (input: ObjectInput) => (await apiClient.post<CustomObjectDef>("/custom-objects", input)).data,
    onSuccess: (o) => done(o.key),
  })
}

export function useUpdateCustomObject(key: string) {
  const done = useInvalidateDefinitions()
  return useMutation({
    mutationFn: async (input: ObjectInput) => (await apiClient.patch<CustomObjectDef>(base(key), input)).data,
    onSuccess: () => done(key),
  })
}

export function useDeleteCustomObject() {
  const done = useInvalidateDefinitions()
  return useMutation({
    mutationFn: async (key: string) => (await apiClient.delete(base(key))).data,
    onSuccess: (_d, key) => done(key),
  })
}

export interface FieldInput {
  key?: string
  label?: string
  type?: string
  required?: boolean
  is_unique?: boolean
  is_title?: boolean
  show_in_list?: boolean
  options?: Record<string, unknown>
  help_text?: string | null
}

export function useCustomFieldMutations(objectKey: string) {
  const done = useInvalidateDefinitions()
  const create = useMutation({
    mutationFn: async (input: FieldInput) => (await apiClient.post<CustomFieldDef>(`${base(objectKey)}/fields`, input)).data,
    onSuccess: () => done(objectKey),
  })
  const update = useMutation({
    mutationFn: async ({ fieldKey, input }: { fieldKey: string; input: FieldInput }) =>
      (await apiClient.patch<CustomFieldDef>(`${base(objectKey)}/fields/${encodeURIComponent(fieldKey)}`, input)).data,
    onSuccess: () => done(objectKey),
  })
  const remove = useMutation({
    mutationFn: async (fieldKey: string) => (await apiClient.delete(`${base(objectKey)}/fields/${encodeURIComponent(fieldKey)}`)).data,
    onSuccess: () => done(objectKey),
  })
  const reorder = useMutation({
    mutationFn: async (keys: string[]) => (await apiClient.put(`${base(objectKey)}/fields/order`, { keys })).data,
    onSuccess: () => done(objectKey),
  })
  return { create, update, remove, reorder }
}

export function useFormulaPreview() {
  return useMutation({
    mutationFn: async (input: { object_key: string; expression: string; sample?: Record<string, unknown>; editing_key?: string }) =>
      (await apiClient.post<{ ok: true; result: number | null } | { ok: false; error: string }>("/custom-objects/formula/preview", input)).data,
  })
}

export function useCustomTemplates(enabled = true) {
  return useQuery<CustomTemplateInfo[]>({
    queryKey: customKeys.templates,
    queryFn: async () => (await apiClient.get<CustomTemplateInfo[]>("/custom-objects/templates")).data,
    enabled,
  })
}

export function useApplyCustomTemplate() {
  const done = useInvalidateDefinitions()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ template, withSampleData }: { template: string; withSampleData: boolean }) =>
      (await apiClient.post<{ created: string[]; existing: string[]; sample_records: number }>(
        `/custom-objects/templates/${encodeURIComponent(template)}/apply`,
        { with_sample_data: withSampleData },
      )).data,
    onSuccess: () => {
      done()
      void qc.invalidateQueries({ queryKey: customKeys.templates })
    },
  })
}

/** Số bản ghi mỗi trang (người dùng chọn được). */
export const PAGE_SIZES = [20, 50, 100] as const
export const DEFAULT_PAGE_SIZE = 20

/**
 * Danh sách bản ghi — PHÂN TRANG theo số trang: BE nhận `page` + `limit`, luôn trả `total`.
 * Giữ trang cũ trên màn hình khi chuyển trang (`keepPreviousData`) để bảng không nhấp nháy.
 */
export function useCustomRecords(key: string, params: RecordListParams, page = 1, limit = DEFAULT_PAGE_SIZE, enabled = true) {
  return useQuery<CustomRecordPage>({
    queryKey: [...customKeys.records(key, params), page, limit],
    queryFn: async () => (await apiClient.get<CustomRecordPage>(`${base(key)}/records`, { params: { ...params, limit, page } })).data,
    placeholderData: keepPreviousData,
    enabled,
  })
}

export function useCustomRecord(key: string, id: number | undefined) {
  return useQuery<CustomRecord>({
    queryKey: customKeys.record(key, id ?? 0),
    queryFn: async () => (await apiClient.get<CustomRecord>(`${base(key)}/records/${id}`)).data,
    enabled: id !== undefined && Number.isFinite(id),
    retry: (count, err) => (err as { response?: { status?: number } })?.response?.status !== 404 && count < 2,
  })
}

export function useCustomRelated(key: string, id: number | undefined) {
  return useQuery<CustomRelatedGroup[]>({
    queryKey: customKeys.related(key, id ?? 0),
    queryFn: async () => (await apiClient.get<CustomRelatedGroup[]>(`${base(key)}/records/${id}/related`)).data,
    enabled: id !== undefined && Number.isFinite(id),
  })
}

export interface RecordInput {
  data: CustomRecordData
  owner_id?: number
}

export function useCustomRecordMutations(key: string) {
  const qc = useQueryClient()
  const refresh = (id?: number) => {
    void qc.invalidateQueries({ queryKey: customKeys.recordsOf(key) })
    void qc.invalidateQueries({ queryKey: customKeys.list })
    if (id !== undefined) void qc.invalidateQueries({ queryKey: customKeys.record(key, id) })
    void qc.invalidateQueries({ queryKey: [...ROOT, "related"] })
    void qc.invalidateQueries({ queryKey: [...ROOT, "lookup"] }) // ô chọn liên kết thấy ngay bản ghi mới / không còn bản ghi đã xoá
  }
  const create = useMutation({
    mutationFn: async (input: RecordInput) => (await apiClient.post<CustomRecord>(`${base(key)}/records`, input)).data,
    onSuccess: (r) => refresh(r.id),
  })
  const update = useMutation({
    mutationFn: async ({ id, input }: { id: number; input: Partial<RecordInput> }) =>
      (await apiClient.patch<CustomRecord>(`${base(key)}/records/${id}`, input)).data,
    onSuccess: (r) => refresh(r.id),
  })
  const remove = useMutation({
    mutationFn: async (id: number) => (await apiClient.delete(`${base(key)}/records/${id}`)).data,
    onSuccess: (_d, id) => refresh(id),
  })
  return { create, update, remove }
}

/** Tra cứu cho trường liên kết (chỉ `{id, title}` trong phạm vi xem). `kind`: 'users' | 'contacts' | khoá thực thể đích. */
export function useCustomLookup(kind: string, q: string, enabled: boolean, forPerm?: "view" | "manage") {
  return useQuery<CustomLookupItem[]>({
    queryKey: [...ROOT, "lookup", kind, q, forPerm ?? ""],
    queryFn: async () => {
      const url = kind === "__users" ? "/custom-objects/lookup/users"
        : kind === "__contacts" ? "/custom-objects/lookup/contacts"
        : `${base(kind)}/lookup`
      return (await apiClient.get<CustomLookupItem[]>(url, { params: { q: q || undefined, for: forPerm, limit: 20 } })).data
    },
    enabled,
    staleTime: 15_000,
  })
}

/** Tải CSV (BE cắt ở 20.000 dòng MỚI NHẤT và báo qua header). */
export async function downloadCustomRecordsCsv(key: string, params: RecordListParams): Promise<{ truncated: boolean; exported: number; total: number }> {
  let res
  try {
    res = await apiClient.get(`${base(key)}/records/export`, { params, responseType: "blob" })
  } catch (err) {
    throw new Error(await blobErrorMessage(err))
  }
  const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: "text/csv;charset=utf-8" }))
  const a = document.createElement("a")
  a.href = url
  a.download = `${key}-${todayVn()}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  const h = res.headers as Record<string, string | undefined>
  return { truncated: h["x-truncated"] === "true", exported: Number(h["x-exported-rows"] ?? 0), total: Number(h["x-total-rows"] ?? 0) }
}

/** Thân lỗi của request `responseType: "blob"` là Blob → đọc ra JSON để hiện ĐÚNG lý do của BE, không câu chung. */
export async function blobErrorMessage(err: unknown): Promise<string> {
  const data = (err as { response?: { data?: unknown } })?.response?.data
  if (data instanceof Blob) {
    try {
      const text = typeof data.text === "function" ? await data.text() : await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(r.error)
        r.readAsText(data)
      })
      const j = JSON.parse(text) as { message?: unknown }
      if (typeof j.message === "string") return j.message
    } catch { /* không phải JSON */ }
  }
  return "Không xuất được file, vui lòng thử lại"
}

/** Lỗi theo trường từ BE (`{errors:{khoá: thông báo}}`) — trả `{}` nếu không có. */
export function fieldErrorsOf(err: unknown): Record<string, string> {
  const data = (err as { response?: { data?: { errors?: unknown } } })?.response?.data
  const e = data?.errors
  if (!e || typeof e !== "object") return {}
  return Object.fromEntries(Object.entries(e as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>
}
