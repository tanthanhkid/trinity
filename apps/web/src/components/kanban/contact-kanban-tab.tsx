"use client"

/**
 * Tab "Công việc" ở chi tiết Danh bạ — card gắn khách hàng này,
 * scoped bởi CẢ card RBAC lẫn quyền xem contact (BE `GET /kanban/cards?contact_id=`).
 */
import { useState } from "react"
import { useKanbanCardsByContact } from "@/hooks/kanban/use-kanban-cards"
import { KanbanCardList } from "./kanban-card-list"
import { KanbanCardDialog } from "./kanban-card-dialog"
import { ContactCreateTaskDialog } from "./contact-create-task-dialog"
import { Button } from "@/components/ui/button"
import { Plus } from "lucide-react"
import { usePermissions } from "@/lib/rbac"

export function ContactKanbanTab({ contactId, contactName }: { contactId: number; contactName?: string | null }) {
  const { can } = usePermissions()
  const [creating, setCreating] = useState(false)
  const canCreate = can("contacts.view") && can("kanban.manage") // tạo card = kanban.manage (POST /kanban/cards) + xem Danh bạ
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useKanbanCardsByContact(contactId)
  const [openCardId, setOpenCardId] = useState<number | null>(null)
  const cards = data?.pages.flatMap((p) => p.cards) ?? []

  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4 shadow-[var(--shadow-card)]">
      {canCreate && (
        <div className="mb-3 flex justify-end">
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1 size-4" /> Tạo công việc
          </Button>
        </div>
      )}
      <KanbanCardList
        cards={cards}
        isLoading={isLoading}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onFetchNextPage={() => fetchNextPage()}
        onOpenCard={setOpenCardId}
        showBoardColumn
        showStatusColumn
      />
      <ContactCreateTaskDialog
        open={creating}
        onClose={() => setCreating(false)}
        contactId={contactId}
        contactName={contactName}
      />
      <KanbanCardDialog cardId={openCardId} onClose={() => setOpenCardId(null)} />
    </div>
  )
}
