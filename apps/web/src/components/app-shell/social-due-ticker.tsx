"use client"

import { useOrgFeatures } from "@/hooks/use-org-features"
import { useSocialDueTicker } from "@/hooks/use-social"
import { useFacebookDueTicker } from "@/app/(dashboard)/settings/_components/integrations/use-facebook"
import { usePermissions } from "@/lib/rbac"
import { isPollMode } from "@/lib/realtime-mode"

/** Không vẽ gì: nhắc máy chủ đăng bài hẹn giờ, bước kịch bản Messenger, tin gửi hàng loạt đúng giờ trên bản serverless (xem `useSocialDueTicker`). */
export function SocialDueTicker() {
  const { can } = usePermissions()
  const { features } = useOrgFeatures()
  useSocialDueTicker(isPollMode() && can("social.post") && features.social_posting !== false)
  useFacebookDueTicker(isPollMode() && can("integrations.webhooks") && features.facebook_page !== false)
  return null
}
