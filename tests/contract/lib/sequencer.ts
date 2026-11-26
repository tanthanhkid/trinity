import { BaseSequencer, type TestSpecification } from 'vitest/node'

/** Thứ tự file cố định theo đường dẫn: seed của ca này (id tăng dần) không phụ thuộc cache/thời gian chạy lần trước. */
export class PathSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0))
  }
}
