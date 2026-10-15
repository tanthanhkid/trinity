/**
 * Board mẫu (§Chức năng: "Có sẵn board mẫu để nhân bản") —
 * `super_admin` nhân bản qua `POST /kanban/boards/from-template`.
 * Hằng số THUẦN — KHÔNG đọc DB, KHÔNG side-effect.
 */

export interface KanbanTemplateColumn {
  name: string;
  is_done?: boolean;
}

export interface KanbanTemplate {
  key: string;
  name: string;
  description: string;
  columns: KanbanTemplateColumn[];
}

export const KANBAN_TEMPLATES: readonly KanbanTemplate[] = [
  {
    key: 'sales',
    name: 'Bán hàng',
    description: 'Theo dõi cơ hội bán hàng từ khi tiếp cận tới khi chốt/thua.',
    columns: [
      { name: 'Mới' },
      { name: 'Đã liên hệ' },
      { name: 'Báo giá' },
      { name: 'Chốt', is_done: true },
      { name: 'Thua', is_done: true },
    ],
  },
  {
    key: 'customer_care',
    name: 'Chăm sóc khách hàng',
    description: 'Theo dõi yêu cầu/phản hồi của khách hàng từ khi tiếp nhận tới khi xử lý xong.',
    columns: [
      { name: 'Mới' },
      { name: 'Đang xử lý' },
      { name: 'Chờ phản hồi khách' },
      { name: 'Đã xử lý', is_done: true },
    ],
  },
  {
    key: 'internal_work',
    name: 'Công việc nội bộ',
    description: 'Quản lý công việc nội bộ theo quy trình Cần làm → Đang làm → Chờ duyệt → Xong.',
    columns: [
      { name: 'Cần làm' },
      { name: 'Đang làm' },
      { name: 'Chờ duyệt' },
      { name: 'Xong', is_done: true },
    ],
  },
];

export function findKanbanTemplate(key: string): KanbanTemplate | undefined {
  return KANBAN_TEMPLATES.find((t) => t.key === key);
}
