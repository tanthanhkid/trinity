import { Module } from '@nestjs/common'
import { testHooksEnabled } from '@trinity/rbac-nest'
import { TestHooksController } from './test-hooks.controller'

/** API điều khiển test (C18). Chỉ được nạp từ `MonolithModule` khi `testHooksEnabled()`; ngoài ra route không tồn tại (404). */
@Module({ controllers: [TestHooksController] })
export class TestHooksModule {}

/** Danh sách import cho `MonolithModule`: rỗng ngoài điều kiện (⇒ hai route trả 404, không có mã nào được đăng ký). */
export function testHooksImports(env: NodeJS.ProcessEnv = process.env): (typeof TestHooksModule)[] {
  return testHooksEnabled(env) ? [TestHooksModule] : []
}
