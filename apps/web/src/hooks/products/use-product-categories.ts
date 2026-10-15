"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type {
  CreateAttributeDefPayload,
  CreateProductCategoryPayload,
  ProductAttributeDef,
  ProductCategory,
  UpdateAttributeDefPayload,
  UpdateProductCategoryPayload,
} from "@/types/product-category"

/**
 * Data-layer danh mục/thuộc tính động sản phẩm — mirror quy ước
 * `hooks/products/use-products.ts` (queryKey mảng, `apiClient` trực tiếp).
 */
const CATEGORIES_KEY = "product-categories"
const ATTRIBUTE_DEFS_KEY = "product-attribute-defs"

/** `GET /product-categories` — mọi role đăng nhập. `includeInactive` mặc định false (dropdown tạo sản phẩm). */
export function useProductCategories(includeInactive = false) {
  return useQuery<ProductCategory[]>({
    queryKey: [CATEGORIES_KEY, { includeInactive }],
    queryFn: async () => {
      const qs = includeInactive ? "?include_inactive=true" : ""
      const res = await apiClient.get<ProductCategory[]>(`/product-categories${qs}`)
      return Array.isArray(res.data) ? res.data : []
    },
    staleTime: 60_000,
  })
}

export function useCreateProductCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (payload: CreateProductCategoryPayload) => {
      const res = await apiClient.post<ProductCategory>("/product-categories", payload)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [CATEGORIES_KEY] })
    },
  })
}

export function useUpdateProductCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: UpdateProductCategoryPayload }) => {
      const res = await apiClient.patch<ProductCategory>(`/product-categories/${id}`, payload)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [CATEGORIES_KEY] })
    },
  })
}

/** `GET /product-categories/:categoryId/attribute-defs` — mọi role đăng nhập (form sản phẩm cần render trường động). */
export function useAttributeDefs(categoryId: number | null | undefined) {
  return useQuery<ProductAttributeDef[]>({
    queryKey: [ATTRIBUTE_DEFS_KEY, categoryId],
    queryFn: async () => {
      const res = await apiClient.get<ProductAttributeDef[]>(
        `/product-categories/${categoryId}/attribute-defs`,
      )
      return Array.isArray(res.data) ? res.data : []
    },
    enabled: categoryId != null,
    staleTime: 60_000,
  })
}

export function useCreateAttributeDef() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      categoryId,
      payload,
    }: {
      categoryId: number
      payload: CreateAttributeDefPayload
    }) => {
      const res = await apiClient.post<ProductAttributeDef>(
        `/product-categories/${categoryId}/attribute-defs`,
        payload,
      )
      return res.data
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: [ATTRIBUTE_DEFS_KEY, variables.categoryId] })
    },
  })
}

export function useUpdateAttributeDef() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      payload,
    }: {
      id: number
      payload: UpdateAttributeDefPayload
    }) => {
      const res = await apiClient.patch<ProductAttributeDef>(`/product-attribute-defs/${id}`, payload)
      return res.data
    },
    onSuccess: () => {
      // Không biết category_id của def vừa sửa nếu caller không truyền lại —
      // invalidate CẢ prefix để chắc chắn danh sách trường động refetch đúng.
      queryClient.invalidateQueries({ queryKey: [ATTRIBUTE_DEFS_KEY] })
    },
  })
}

export function useDeleteAttributeDef() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/product-attribute-defs/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [ATTRIBUTE_DEFS_KEY] })
    },
  })
}
