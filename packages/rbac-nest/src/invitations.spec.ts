import { companyIdOfToken } from './company-token';
import { hashInviteToken, invitationStatus, invitePath, newInviteToken } from './invitations';

describe('lời mời nhân viên: token và trạng thái', () => {
  it('token công ty ≥ 2 mang tiền tố cN. (để route đúng schema), công ty 1 không tiền tố; mỗi lần một khác', () => {
    const t = newInviteToken(3);
    expect(t).toMatch(/^c3\.[A-Za-z0-9_-]{43}$/);
    expect(companyIdOfToken(t)).toBe(3);
    expect(newInviteToken(1)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(companyIdOfToken(newInviteToken(1))).toBe(1);
    expect(newInviteToken(3)).not.toBe(t);
  });
  it('băm SHA-256 cố định, không lộ token; đổi tiền tố đổi băm', () => {
    const h = hashInviteToken('c3.abc');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashInviteToken('c3.abc'));
    expect(h).not.toBe(hashInviteToken('c4.abc'));
    expect(h).not.toContain('abc');
  });
  it('đường dẫn trang nhận lời mời', () => {
    expect(invitePath('c3.xyz')).toBe('/invite/c3.xyz');
  });
  it('trạng thái suy ra: đã dùng > đã huỷ > hết hạn > đang chờ', () => {
    const now = new Date('2026-11-26T00:00:00Z');
    const future = new Date('2026-12-01T00:00:00Z');
    const past = new Date('2026-11-01T00:00:00Z');
    expect(invitationStatus({ accepted_at: null, revoked_at: null, expires_at: future }, now)).toBe('pending');
    expect(invitationStatus({ accepted_at: null, revoked_at: null, expires_at: past }, now)).toBe('expired');
    expect(invitationStatus({ accepted_at: null, revoked_at: past, expires_at: future }, now)).toBe('revoked');
    expect(invitationStatus({ accepted_at: past, revoked_at: past, expires_at: future }, now)).toBe('accepted');
  });
});
