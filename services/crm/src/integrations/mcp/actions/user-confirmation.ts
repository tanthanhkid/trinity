import { foldVi } from '../../../custom-objects/view-config';
import type { Z } from '../tools/tool-types';
import { ActionUserError, type DetailLine } from './action-types';

/** Cụm từ (đã bỏ dấu) là lời đồng ý. */
const YES = ['ok', 'oke', 'okie', 'okay', 'dong y', 'duoc', 'dc', 'chot', 'u', 'uh', 'um', 'uk', 'yes', 'y', 'dung roi', 'dung vay', 'chuan', 'chuan roi', 'lam di', 'tao di', 'lam luon', 'tao luon', 'lam vay', 'nhu vay', 'xac nhan', 'duyet', 'go', 'on', 'oki', 'vang', 'da', 'khoi hoi lai', 'khoi hoi', 'dung hoi lai', 'tao ngay', 'lam ngay'];
/** Cụm từ phủ định / còn đổi ý — có mặt thì không tính là đồng ý. */
const NO = ['khong', 'ko', 'k', 'chua', 'dung tao', 'dung lam', 'khoan', 'doi', 'sua lai', 'them', 'bot', 'bo', 'thay', 'no', 'not'];

/** "không cần hỏi lại" là bảo tạo ngay — đổi về "khỏi hỏi lại" trước khi xét phủ định. */
const NO_ASK = ['khong can hoi lai', 'khong can hoi', 'ko can hoi lai', 'ko can hoi'];

/** "không cần thêm gì", "không sao" là đồng ý, không phải phủ định. */
const BENIGN = ['khong can them gi', 'khong can them', 'khong can sua', 'khong can', 'khong sao', 'khong van de', 'khong co gi'];

/** Lời người dùng có phải là lời đồng ý (không kèm phủ định / yêu cầu đổi) không. */
export function isUserConfirmation(words: unknown): boolean {
  let w = ` ${foldVi(typeof words === 'string' ? words : '')} `;
  if (!w.trim()) return false;
  for (const a of NO_ASK) w = w.split(` ${a} `).join(' khoi hoi lai ');
  for (const b of BENIGN) w = w.split(` ${b} `).join(' ');
  if (NO.some((k) => w.includes(` ${k} `))) return false;
  return YES.some((k) => w.includes(` ${k} `));
}

/** Tham số xác nhận cấu trúc bảng mới (create_objects, create_object, propose_workspace, install_object_template). */
export const confirmationParam = (z: Z) =>
  z.string({ error: () => 'Thiếu confirmed_by_user: chưa tạo bảng nào. Danh sách cột dự kiến được đưa người dùng xem; confirmed_by_user là lời người dùng đồng ý sau khi xem. / Missing confirmed_by_user.' })
    .max(300)
    .describe('Lời người dùng đồng ý với danh sách bảng + cột dự kiến, chép nguyên văn (vd "ok tạo đi", "được, làm vậy"). ' +
      'Thường là câu trả lời sau khi họ đã xem danh sách cột. Nếu ngay trong lời yêu cầu người dùng đã nói rõ muốn tạo ngay, không cần hỏi lại ' +
      '(vd "tạo luôn", "làm luôn", "khỏi hỏi lại") thì câu yêu cầu đó là lời đồng ý. ' +
      'Lời yêu cầu không có ý đó (vd "tạo cho mình bảng…") chưa phải là lời đồng ý: khi đó máy chủ không tạo gì và trả lại danh sách cột dự kiến để người dùng xem. / ' +
      "The user's own words agreeing to the proposed tables and columns, copied verbatim — usually their reply after seeing them. " +
      'If the request itself already says to create right away without asking again ("tạo luôn", "làm luôn", "khỏi hỏi lại"), that request is the confirmation; ' +
      'a plain request is not (nothing is created and the planned columns are returned).');

/** Câu chèn vào mô tả tool: khi nào là có lời đồng ý. */
export const CONSENT_NOTE = 'lời họ đồng ý sau khi xem danh sách, hoặc chính lời yêu cầu khi họ đã nói rõ tạo ngay không cần hỏi lại (vd "tạo luôn", "khỏi hỏi lại")';

/** Không phải lời đồng ý ⇒ ném lỗi kèm bản xem trước các cột để AI đưa người dùng xác nhận. */
export function assertConfirmed(words: unknown, preview: DetailLine[]): void {
  if (isUserConfirmation(words)) return;
  const said = typeof words === 'string' && words.trim() ? `“${words.trim().slice(0, 80)}”` : '(trống)';
  const plan = preview.map((d) => `${d.label}: ${d.value}`).join(' | ');
  throw new ActionUserError(`Chưa tạo gì: chưa có lời người dùng đồng ý với cấu trúc này (confirmed_by_user = ${said}). Cấu trúc dự kiến — ${plan}. ` +
    'Cấu trúc bảng mới do người dùng duyệt: họ xem danh sách trên, sửa nếu cần, rồi đồng ý; confirmed_by_user là câu đồng ý đó. / ' +
    `Nothing created: no user confirmation of this structure (confirmed_by_user = ${said}). Planned structure: ${plan}`);
}
