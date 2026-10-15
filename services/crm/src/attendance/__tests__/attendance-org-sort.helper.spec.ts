import {
  compareByOrgOrder,
  resolveTeamName,
  toOrgSortRow,
  intersectUserIdFilter,
  type OrgSortRow,
  type OrgUserLite,
  type TeamOrgLookup,
} from '../attendance-org-sort.helper';

// Helper cục bộ chỉ cho test — dựng TeamOrgLookup từ danh sách team KHÔNG qua Prisma
// (loadTeamOrgLookup() thật gọi prisma.team.findMany, không cần trong unit test này).
function buildLookup(
  teams: Array<{ id: number; name: string; team_lead_id: number | null }>,
): TeamOrgLookup {
  const sorted = [...teams].sort((a, b) => a.id - b.id);
  const teamIdByLeadId = new Map<number, number>();
  for (const t of sorted) {
    if (t.team_lead_id != null && !teamIdByLeadId.has(t.team_lead_id)) {
      teamIdByLeadId.set(t.team_lead_id, t.id);
    }
  }
  return { teamIdByLeadId, teamNameById: new Map(teams.map((t) => [t.id, t.name])) };
}

function user(overrides: Partial<OrgUserLite> = {}): OrgUserLite {
  return {
    id: 1,
    manager_id: null,
    full_name: 'A',
    employee: { team_id: null, department: null, jobTitle: null },
    ...overrides,
  };
}

describe('resolveTeamName', () => {
  const lookup = buildLookup([
    { id: 10, name: 'Team Kinh doanh 1', team_lead_id: 5 },
    { id: 11, name: 'Team Kinh doanh 2', team_lead_id: null },
  ]);

  it('ưu tiên employees.team_id trực tiếp', () => {
    const u = user({ id: 99, employee: { team_id: 11, department: null, jobTitle: null } });
    expect(resolveTeamName(u, lookup)).toBe('Team Kinh doanh 2');
  });

  it('NV là trưởng nhóm (teams.team_lead_id = user.id) → team của chính mình', () => {
    const u = user({ id: 5, employee: { team_id: null, department: null, jobTitle: null } });
    expect(resolveTeamName(u, lookup)).toBe('Team Kinh doanh 1');
  });

  it('quản lý của NV là trưởng nhóm (teams.team_lead_id = user.manager_id)', () => {
    const u = user({
      id: 200,
      manager_id: 5,
      employee: { team_id: null, department: null, jobTitle: null },
    });
    expect(resolveTeamName(u, lookup)).toBe('Team Kinh doanh 1');
  });

  it('không resolve được → null ("Chưa gán Team" ở tầng hiển thị)', () => {
    const u = user({ id: 300, manager_id: 999 });
    expect(resolveTeamName(u, lookup)).toBeNull();
  });

  it('user null/undefined → null (an toàn)', () => {
    expect(resolveTeamName(null, lookup)).toBeNull();
    expect(resolveTeamName(undefined, lookup)).toBeNull();
  });

  it('employee null (chưa auto-provision) → vẫn resolve qua team_lead/manager', () => {
    const u: OrgUserLite = { id: 5, manager_id: null, full_name: 'A', employee: null };
    expect(resolveTeamName(u, lookup)).toBe('Team Kinh doanh 1');
  });
});

describe('compareByOrgOrder', () => {
  const row = (p: Partial<OrgSortRow>): OrgSortRow => ({
    department: null,
    team_name: null,
    job_title_sort_order: null,
    full_name: null,
    ...p,
  });

  it('nhóm theo Phòng ban trước (A→Z)', () => {
    const a = row({ department: 'Phòng Kinh doanh' });
    const b = row({ department: 'Phòng Marketing' });
    expect(compareByOrgOrder(a, b)).toBeLessThan(0);
    expect(compareByOrgOrder(b, a)).toBeGreaterThan(0);
  });

  it('Phòng ban null/rỗng xếp CUỐI', () => {
    const withDept = row({ department: 'Phòng Kinh doanh' });
    const noDept = row({ department: null });
    expect(compareByOrgOrder(withDept, noDept)).toBeLessThan(0);
    expect(compareByOrgOrder(noDept, withDept)).toBeGreaterThan(0);
    expect(compareByOrgOrder(row({ department: '  ' }), withDept)).toBeGreaterThan(0);
  });

  it('cùng Phòng ban → nhóm theo Team (A→Z), Team null xếp CUỐI', () => {
    const t1 = row({ department: 'Phòng KD', team_name: 'Team 1' });
    const t2 = row({ department: 'Phòng KD', team_name: 'Team 2' });
    const noTeam = row({ department: 'Phòng KD', team_name: null });
    expect(compareByOrgOrder(t1, t2)).toBeLessThan(0);
    expect(compareByOrgOrder(t2, noTeam)).toBeLessThan(0);
  });

  it('cùng Team → sắp theo cấp chức danh sort_order DESC (Trưởng nhóm chính(60) → Chuyên viên chính(30) → Chuyên viên(20) → Nhân viên(10))', () => {
    const truongNhomChinh = row({ department: 'D', team_name: 'T', job_title_sort_order: 60 });
    const chuyenVienChinh = row({ department: 'D', team_name: 'T', job_title_sort_order: 30 });
    const chuyenVien = row({ department: 'D', team_name: 'T', job_title_sort_order: 20 });
    const nhanVien = row({ department: 'D', team_name: 'T', job_title_sort_order: 10 });
    const arr = [nhanVien, chuyenVien, truongNhomChinh, chuyenVienChinh];
    arr.sort(compareByOrgOrder);
    expect(arr).toEqual([truongNhomChinh, chuyenVienChinh, chuyenVien, nhanVien]);
  });

  it('chức danh null (chưa gán) xếp DƯỚI CÙNG, kể cả dưới Học việc (sort_order=0)', () => {
    const hocViec = row({ department: 'D', team_name: 'T', job_title_sort_order: 0 });
    const chuaGan = row({ department: 'D', team_name: 'T', job_title_sort_order: null });
    expect(compareByOrgOrder(hocViec, chuaGan)).toBeLessThan(0);
  });

  it('cùng mọi tầng → sắp theo tên A→Z', () => {
    const a = row({ department: 'D', team_name: 'T', job_title_sort_order: 10, full_name: 'An' });
    const b = row({ department: 'D', team_name: 'T', job_title_sort_order: 10, full_name: 'Bình' });
    expect(compareByOrgOrder(a, b)).toBeLessThan(0);
  });
});

describe('toOrgSortRow', () => {
  it('map đúng field từ OrgUserLite + team_name truyền vào', () => {
    const u = user({
      full_name: 'Nguyễn Văn A',
      employee: { team_id: 1, department: 'Phòng KD', jobTitle: { sort_order: 30 } },
    });
    expect(toOrgSortRow(u, 'Team 1')).toEqual({
      department: 'Phòng KD',
      team_name: 'Team 1',
      job_title_sort_order: 30,
      full_name: 'Nguyễn Văn A',
    });
  });

  it('user null → mọi field null', () => {
    expect(toOrgSortRow(null, null)).toEqual({
      department: null,
      team_name: null,
      job_title_sort_order: null,
      full_name: null,
    });
  });
});

// filter Team ở 4 tab chấm công phải giao (AND) an toàn với
// where.user_id đã có (IDOR self-scope / dto.user_id), KHÔNG ghi đè nhau.
describe('intersectUserIdFilter', () => {
  it('existing undefined → dùng thẳng danh sách Team resolve được', () => {
    expect(intersectUserIdFilter(undefined, [1, 2, 3])).toEqual({ in: [1, 2, 3] });
  });

  it('existing là số (IDOR self-scope) khớp Team → giữ nguyên số đó', () => {
    expect(intersectUserIdFilter(2, [1, 2, 3])).toBe(2);
  });

  it('existing là số KHÔNG thuộc Team → sentinel -1 (0 dòng, KHÔNG leak)', () => {
    expect(intersectUserIdFilter(99, [1, 2, 3])).toBe(-1);
  });

  it('existing là { in: [...] } → giao 2 tập', () => {
    expect(intersectUserIdFilter({ in: [2, 3, 4] }, [1, 2, 3])).toEqual({ in: [2, 3] });
  });

  it('existing { in: [...] } không giao nhau → { in: [] } (0 dòng)', () => {
    expect(intersectUserIdFilter({ in: [10, 11] }, [1, 2, 3])).toEqual({ in: [] });
  });

  it('Team rỗng (không NV nào thuộc team) → { in: [] }', () => {
    expect(intersectUserIdFilter(undefined, [])).toEqual({ in: [] });
  });
});
