import {
  groupLoginWifiTargets,
  isLoginWifiTargeted,
  resolveLoginWifiTargetedForUser,
  type LoginWifiTargetSets,
} from './login-wifi-check-targets.helper'

const emptySets = (): LoginWifiTargetSets => ({
  userIds: new Set(),
  teamLeadIds: new Set(),
  departmentIds: new Set(),
})

describe('login-wifi-check-targets.helper', () => {
  describe('groupLoginWifiTargets', () => {
    it('nhóm đúng theo 3 scope_type, bỏ qua giá trị lạ', () => {
      const sets = groupLoginWifiTargets([
        { scope_type: 'user', target_user_id: 1 },
        { scope_type: 'team', target_user_id: 2 },
        { scope_type: 'department', target_user_id: 3 },
        { scope_type: 'unknown', target_user_id: 999 },
      ])
      expect(sets.userIds.has(1)).toBe(true)
      expect(sets.teamLeadIds.has(2)).toBe(true)
      expect(sets.departmentIds.has(3)).toBe(true)
      expect(sets.userIds.has(999)).toBe(false)
      expect(sets.teamLeadIds.has(999)).toBe(false)
      expect(sets.departmentIds.has(999)).toBe(false)
    })

    it('mảng rỗng → 3 set rỗng', () => {
      const sets = groupLoginWifiTargets([])
      expect(sets.userIds.size).toBe(0)
      expect(sets.teamLeadIds.size).toBe(0)
      expect(sets.departmentIds.size).toBe(0)
    })
  })

  describe('isLoginWifiTargeted', () => {
    it('3 set rỗng → không ai bị áp dụng (opt-in)', () => {
      expect(
        isLoginWifiTargeted({ userId: 1, managerId: null, grandManagerId: null }, emptySets()),
      ).toBe(false)
    })

    it('scope "user" khớp trực tiếp userId', () => {
      const sets = emptySets()
      sets.userIds.add(10)
      expect(isLoginWifiTargeted({ userId: 10, managerId: null, grandManagerId: null }, sets)).toBe(true)
      expect(isLoginWifiTargeted({ userId: 11, managerId: null, grandManagerId: null }, sets)).toBe(false)
    })

    it('scope "team" khớp CHÍNH team_lead được chọn', () => {
      const sets = emptySets()
      sets.teamLeadIds.add(20)
      expect(isLoginWifiTargeted({ userId: 20, managerId: null, grandManagerId: null }, sets)).toBe(true)
    })

    it('scope "team" khớp sale báo cáo TRỰC TIẾP cho team_lead đã chọn', () => {
      const sets = emptySets()
      sets.teamLeadIds.add(20)
      expect(isLoginWifiTargeted({ userId: 99, managerId: 20, grandManagerId: null }, sets)).toBe(true)
    })

    it('scope "team" KHÔNG lan sang cấp ông/cháu (chỉ 1 cấp)', () => {
      const sets = emptySets()
      sets.teamLeadIds.add(20)
      // grandManagerId=20 nhưng managerId khác 20 → sale này KHÔNG báo cáo
      // trực tiếp team_lead 20, chỉ có "ông" trùng — team KHÔNG có subtree 2 cấp.
      expect(isLoginWifiTargeted({ userId: 99, managerId: 30, grandManagerId: 20 }, sets)).toBe(false)
    })

    it('scope "department" khớp CHÍNH quản lý phòng được chọn', () => {
      const sets = emptySets()
      sets.departmentIds.add(60)
      expect(isLoginWifiTargeted({ userId: 60, managerId: null, grandManagerId: null }, sets)).toBe(true)
    })

    it('scope "department" khớp team_lead báo cáo trực tiếp quản lý phòng (cấp 1)', () => {
      const sets = emptySets()
      sets.departmentIds.add(60)
      expect(isLoginWifiTargeted({ userId: 50, managerId: 60, grandManagerId: null }, sets)).toBe(true)
    })

    it('scope "department" khớp sale dưới team_lead dưới quản lý phòng (cấp 2, subtree đầy đủ)', () => {
      const sets = emptySets()
      sets.departmentIds.add(60)
      expect(isLoginWifiTargeted({ userId: 99, managerId: 50, grandManagerId: 60 }, sets)).toBe(true)
    })

    it('user KHÔNG thuộc bất kỳ scope nào → false dù có target khác đang cấu hình', () => {
      const sets = emptySets()
      sets.userIds.add(1)
      sets.teamLeadIds.add(20)
      sets.departmentIds.add(60)
      expect(isLoginWifiTargeted({ userId: 999, managerId: 888, grandManagerId: 777 }, sets)).toBe(false)
    })
  })

  describe('resolveLoginWifiTargetedForUser — RẺ + FAIL-OPEN', () => {
    it('bảng rỗng → false (không ai bị áp dụng), KHÔNG gọi user.findUnique (bail sớm)', async () => {
      const findMany = jest.fn().mockResolvedValue([])
      const findUnique = jest.fn()
      const result = await resolveLoginWifiTargetedForUser(
        { loginWifiCheckTarget: { findMany }, user: { findUnique } },
        1,
      )
      expect(result).toBe(false)
      // Bail sớm THẬT SỰ — KHÔNG chỉ 2 query chạy song song rồi bỏ kết quả:
      // đường login phải RẺ, tránh tốn 1 query PK vô ích ở ca phổ biến nhất
      // (chưa cấu hình / vừa xoá sạch danh sách).
      expect(findUnique).not.toHaveBeenCalled()
    })

    it('user không tồn tại (findUnique null) → false, KHÔNG throw', async () => {
      const findMany = jest.fn().mockResolvedValue([{ scope_type: 'user', target_user_id: 1 }])
      const findUnique = jest.fn().mockResolvedValue(null)
      const result = await resolveLoginWifiTargetedForUser(
        { loginWifiCheckTarget: { findMany }, user: { findUnique } },
        1,
      )
      expect(result).toBe(false)
    })

    it('user nằm trong danh sách (scope user) → true', async () => {
      const findMany = jest.fn().mockResolvedValue([{ scope_type: 'user', target_user_id: 7 }])
      const findUnique = jest.fn().mockResolvedValue({ id: 7, manager_id: null, manager: null })
      const result = await resolveLoginWifiTargetedForUser(
        { loginWifiCheckTarget: { findMany }, user: { findUnique } },
        7,
      )
      expect(result).toBe(true)
    })

    it('lỗi đọc bảng target (DB timeout) → fail-open, trả false, KHÔNG throw ra ngoài', async () => {
      const findMany = jest.fn().mockRejectedValue(new Error('DB timeout'))
      const findUnique = jest.fn()
      const result = await resolveLoginWifiTargetedForUser(
        { loginWifiCheckTarget: { findMany }, user: { findUnique } },
        1,
      )
      expect(result).toBe(false)
    })

    it('lỗi đọc chain manager (user.findUnique reject) → fail-open, trả false', async () => {
      const findMany = jest.fn().mockResolvedValue([{ scope_type: 'user', target_user_id: 1 }])
      const findUnique = jest.fn().mockRejectedValue(new Error('DB timeout'))
      const result = await resolveLoginWifiTargetedForUser(
        { loginWifiCheckTarget: { findMany }, user: { findUnique } },
        1,
      )
      expect(result).toBe(false)
    })
  })
})
