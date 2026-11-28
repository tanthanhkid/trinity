import { useQuery } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { useOrgFeatures } from "@/hooks/use-org-features"
import { usePermissions } from "@/lib/rbac"
import { INBOX_CHANNEL_PERMISSION } from "@/app/(dashboard)/inbox/_components/inbox-access"

/**
 * Nút «Messenger» ở hồ sơ khách (khach-desktop / khach-mobile): hội thoại Messenger mới nhất đã ghép với khách
 * (`GET /facebook/conversations?contact_id=`) ⇒ đường dẫn mở đúng hội thoại ở Hộp thư. Chỉ hỏi máy chủ khi người xem thấy
 * kênh Messenger ở Hộp thư (cùng luật quyền + công tắc với `/inbox`); khách chưa từng nhắn Page ⇒ `null`, không hiện nút.
 */
export function useContactMessengerHref(contactId: number | string | undefined): string | null {
  const { can } = usePermissions()
  const { features, isResolved } = useOrgFeatures()
  const id = Number(contactId)
  // Cùng luật với `inboxChannels` (kênh Messenger ở /inbox): quyền + công tắc Hộp thư + công tắc Fanpage — nhưng chờ cấu
  // tính năng đọc xong (fail-closed) để không bắn yêu cầu 403 khi tổ chức tắt Fanpage.
  const enabled =
    Number.isInteger(id) && id > 0 && can(INBOX_CHANNEL_PERMISSION.facebook) && isResolved && features.inbox !== false && features.facebook_page !== false
  const { data } = useQuery<number | null>({
    queryKey: ["facebook", "conversations", "contact", id],
    enabled,
    staleTime: 60_000,
    queryFn: async () =>
      (await apiClient.get<{ data: { id: number }[] }>("/facebook/conversations", { params: { contact_id: id, limit: 1 } })).data.data[0]?.id ?? null,
  })
  return enabled && data ? `/inbox?kenh=facebook&hoi_thoai=${data}` : null
}
