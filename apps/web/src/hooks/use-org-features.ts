import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { isOrgFeatureOn, resolveOrgFeatures } from "@trinity/rbac"
import type { LockedFeatureReasons, OrgFeatureKey, OrgFeatures } from "@trinity/rbac"
import apiClient from "@/lib/api-client"

/** Phản hồi `GET /settings/org-features`: boolean theo khoá + `locked` (chỉ khi serverless). */
export type OrgFeaturesPayload = OrgFeatures & { locked?: LockedFeatureReasons }

/**
 * "Tính năng của tổ chức" — công tắc ẩn/hiện theo TỔ CHỨC, ĐỘC LẬP
 * với RBAC (quyền vẫn do BE kiểm). Cấu hình ở Cài đặt > Tính năng.
 *
 * Fail-open: đang tải / lỗi mạng / API lỗi → coi như BẬT hết (không khoá nhầm
 * menu của cả công ty vì 1 lần fetch hỏng). Đây là tính năng ẨN UI, không phải
 * biên bảo mật nên fail-open là đúng.
 */
export const ORG_FEATURES_KEY = ["settings", "org-features"] as const

export function useOrgFeatures(): {
  features: OrgFeatures
  isLoading: boolean
  /**
   * `true` CHỈ khi cấu hình đã đọc THÀNH CÔNG từ BE. Đang tải / lỗi → `false`
   * (`features` lúc đó là "bật hết" do fail-open). Dùng cho thứ cần FAIL-CLOSED
   * (vd kết nối tích hợp) — menu/UI vẫn đọc `features` fail-open.
   */
  isResolved: boolean
  /** Khoá bị KHOÁ TẮT cố định ở runtime hiện tại → lý do (serverless). `{}` khi không khoá. */
  locked: LockedFeatureReasons
} {
  const { data, isLoading } = useQuery<OrgFeaturesPayload>({
    queryKey: ORG_FEATURES_KEY,
    queryFn: async () => (await apiClient.get<OrgFeaturesPayload>("/settings/org-features")).data,
    staleTime: 60_000,
  })
  // useMemo: giữ tham chiếu ổn định để các useMemo phụ thuộc `features` (sidebar) không tính lại mỗi render.
  const features = useMemo(() => resolveOrgFeatures(data), [data])
  const locked = useMemo<LockedFeatureReasons>(() => data?.locked ?? {}, [data])
  return { features, isLoading, isResolved: data !== undefined, locked }
}

/** Tính năng `key` đang bật? (đang tải/lỗi → true). */
export function useOrgFeature(key: OrgFeatureKey): boolean {
  const { features } = useOrgFeatures()
  return isOrgFeatureOn(features, key)
}

export function useUpdateOrgFeatures() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (patch: Partial<OrgFeatures>) =>
      (await apiClient.put<OrgFeaturesPayload>("/settings/org-features", patch)).data,
    onSuccess: (data) => {
      qc.setQueryData(ORG_FEATURES_KEY, data)
    },
  })
}
