"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"

/**
 * Ghi nhận khách vừa mở để hiện trong "KHÁCH GẦN ĐÂY" ở sidebar.
 * Fire-and-forget — lỗi ghi nhận KHÔNG được chặn/làm phiền trang chi tiết.
 */
export function useMarkContactViewed() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (contactId: number) => apiClient.post(`/contacts/${contactId}/viewed`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contacts", "recent"] })
    },
    onError: () => {
      // Tiện ích phụ — không toast, không throw lên UI trang chi tiết.
    },
  })
}
