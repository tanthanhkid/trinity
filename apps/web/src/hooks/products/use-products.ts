"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type {
  CreateProductPayload,
  ListProductsParams,
  Product,
  UpdateProductPayload,
} from "@/types/product"

/**
 * Data-layer màn "Sản phẩm" (tổng quát hoá đa ngành).
 * queryKey mảng, `apiClient` trực tiếp, KHÔNG coalesce field tiền `null → 0`.
 */
const PRODUCTS_KEY = "products"

function buildQuery(params: ListProductsParams): string {
  const q = new URLSearchParams()
  if (params.project_id != null) q.set("project_id", String(params.project_id))
  if (params.category_id != null) q.set("category_id", String(params.category_id))
  if (params.is_active != null) q.set("is_active", String(params.is_active))
  if (params.q) q.set("q", params.q)
  if (params.archived) q.set("archived", "true")
  return q.toString()
}

/** `GET /products` — quyền `products.view`. */
export function useProducts(params: ListProductsParams = {}, opts: { enabled?: boolean } = {}) {
  return useQuery<Product[]>({
    enabled: opts.enabled ?? true,
    queryKey: [PRODUCTS_KEY, params],
    queryFn: async () => {
      const qs = buildQuery(params)
      const res = await apiClient.get<Product[]>(`/products${qs ? `?${qs}` : ""}`)
      return Array.isArray(res.data) ? res.data : []
    },
    staleTime: 60_000,
  })
}

/** `POST /products` — quyền `products.manage`. */
export function useCreateProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (payload: CreateProductPayload) => {
      const res = await apiClient.post<Product>("/products", payload)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [PRODUCTS_KEY] })
    },
  })
}

/** `PATCH /products/:id` — quyền `products.manage`. */
export function useUpdateProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: UpdateProductPayload }) => {
      const res = await apiClient.patch<Product>(`/products/${id}`, payload)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [PRODUCTS_KEY] })
    },
  })
}

/** `DELETE /products/:id` — quyền `products.manage`; XOÁ HẲN, 409 nếu đã có đơn/liên hệ tham chiếu. Ẩn = `useUpdateProduct` với `is_active:false`. */
/** `POST /products/:id/restore` — Hoàn tác xoá (người đã xoá / Quản trị, trong 10 phút). */
export function useRestoreProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => (await apiClient.post<Product>(`/products/${id}/restore`)).data,
    onSettled: () => queryClient.invalidateQueries({ queryKey: [PRODUCTS_KEY] }),
  })
}

/** `DELETE /products/:id/permanent` — xoá HẲN, chỉ Quản trị, chỉ khi chưa đơn / liên hệ nào dùng (409 nếu còn). */
export function usePurgeProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/products/${id}/permanent`)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [PRODUCTS_KEY] }),
  })
}

/** `DELETE /products/:id` — xoá = lưu trữ (xoá mềm); Hoàn tác bằng `useRestoreProduct`. */
export function useDeleteProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/products/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [PRODUCTS_KEY] })
    },
  })
}

/**
 * `POST /products/upload-image` — tải ảnh minh hoạ từ máy, chỉ
 * `super_admin` hoặc quyền quản lý sản phẩm. Trả `{ image_url }` (đường dẫn tương đối
 * `/uploads/products/...`) để gán vào `image_url` của sản phẩm.
 * multipart PHẢI khai `Content-Type` tường minh, không axios serialize JSON.
 */
export function useUploadProductImage() {
  return useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData()
      fd.append("file", file)
      const res = await apiClient.post<{ image_url: string }>("/products/upload-image", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      return res.data.image_url
    },
  })
}
