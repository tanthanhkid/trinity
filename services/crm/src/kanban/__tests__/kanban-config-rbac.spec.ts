import { Reflector } from '@nestjs/core';
import type { Permission } from '@trinity/rbac';
import type { AccessMeta } from '@trinity/rbac-nest';
import { RBAC_META } from '@trinity/rbac-nest';
import { KanbanBoardsController } from '../boards/kanban-boards.controller';
import { KanbanColumnsController } from '../columns/kanban-columns.controller';
import { KanbanFieldDefsController } from '../field-defs/kanban-field-defs.controller';

/**
 * Khoá bất biến "Cấu hình board/cột/field-def CHỈ người giữ quyền
 * `kanban.boards`" bằng cách
 * đọc metadata `@Can`/`RBAC_META` THẬT khai trên handler — mirror cách repo
 * verify RBAC ở nơi khác, tránh drift decorator vs ý định. `PermissionGuard`
 * (đã có unit test riêng ở `packages/rbac-nest`) chịu trách nhiệm THI HÀNH
 * metadata này lúc runtime — spec này chỉ khoá "handler đúng gắn cái gì".
 */
function readMeta(klass: { prototype: object }, method?: string): AccessMeta | undefined {
  const reflector = new Reflector();
  const target = method ? (klass.prototype as Record<string, () => void>)[method] : klass;
  return reflector.get<AccessMeta | undefined>(RBAC_META, target as never);
}

function expectCan(klass: { prototype: object }, method: string, permission: Permission) {
  expect(readMeta(klass, method)).toEqual({ kind: 'can', permissions: [permission], mode: 'all' });
}

describe('Kanban — cấu hình board/cột/field-def CHỈ quyền kanban.boards', () => {
  it('KanbanBoardsController.create/update/remove/createFromTemplate/listTemplates — kanban.boards', () => {
    for (const method of ['create', 'update', 'remove', 'createFromTemplate', 'listTemplates']) {
      expectCan(KanbanBoardsController, method, 'kanban.boards');
    }
  });

  it('KanbanBoardsController.findAll/findOne — kanban.view (mọi người có quyền công việc)', () => {
    expectCan(KanbanBoardsController, 'findAll', 'kanban.view');
    expectCan(KanbanBoardsController, 'findOne', 'kanban.view');
  });

  it('KanbanBoardsController — nhãn màu (labels) dùng kanban.view, KHÔNG phải kanban.boards', () => {
    expectCan(KanbanBoardsController, 'createLabel', 'kanban.view');
    expectCan(KanbanBoardsController, 'updateLabel', 'kanban.view');
    expectCan(KanbanBoardsController, 'removeLabel', 'kanban.view');
  });

  it('KanbanColumnsController (class-level @Can) — mọi handler kế thừa kanban.boards', () => {
    expect(readMeta(KanbanColumnsController)).toEqual({
      kind: 'can',
      permissions: ['kanban.boards'],
      mode: 'all',
    });
    for (const method of ['create', 'reorder', 'update', 'remove']) {
      // Không override method-level — Reflector.getAllAndOverride (dùng thật
      // trong PermissionGuard) sẽ rơi về class-level. Ở đây chỉ cần khẳng
      // định method KHÔNG tự khai gì khác đè lên class.
      expect(readMeta(KanbanColumnsController, method)).toBeUndefined();
    }
  });

  it('KanbanFieldDefsController (class-level @Can) — mọi handler kế thừa kanban.boards', () => {
    expect(readMeta(KanbanFieldDefsController)).toEqual({
      kind: 'can',
      permissions: ['kanban.boards'],
      mode: 'all',
    });
    for (const method of ['create', 'reorder', 'update', 'remove']) {
      expect(readMeta(KanbanFieldDefsController, method)).toBeUndefined();
    }
  });
});
