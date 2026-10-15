/**
 * Kịch bản phỏng vấn dựng CRM — văn bản cho AI của khách (ChatGPT/Claude/Gemini) đọc qua get_setup_guide và
 * server instructions. Trinity KHÔNG tự chạy AI: đây chỉ là hướng dẫn cho agent của khách.
 */
export const SETUP_INTERVIEW: readonly { topic: string; ask: string; why: string }[] = [
  { topic: 'nganh', ask: 'Công ty anh/chị làm ngành gì, bán sản phẩm/dịch vụ gì, khoảng bao nhiêu người dùng CRM?', why: 'Chọn bảng chính và mẫu ngành gần nhất (list_object_templates).' },
  { topic: 'doi_tuong', ask: 'Anh/chị đang theo dõi những "thứ" nào: khách hàng, học viên, hồ sơ, đơn hàng, căn hộ, lịch hẹn…? Mỗi thứ cần ghi những thông tin gì?', why: 'Mỗi "thứ" là một bảng; thông tin là các trường.' },
  { topic: 'quy_trinh', ask: 'Từ lúc có một khách mới tới lúc chốt và chăm sóc sau bán, khách đi qua những bước nào (theo thứ tự)? Bước nào hay bị kẹt?', why: 'Các bước = trường select "Trạng thái" theo đúng thứ tự → màn kanban.' },
  { topic: 'nguoi', ask: 'Ai làm bước nào (sale, tư vấn, kế toán, quản lý)? Ai được xem dữ liệu của ai?', why: 'Trường người phụ trách (type user) và vai trò được thấy menu (set_menu.roles).' },
  { topic: 'cong_cu', ask: 'Hiện anh/chị theo dõi bằng gì: Google Sheet, Excel, sổ tay, phần mềm khác? Cần chấm công, lương, bán hàng tại quầy, Zalo… không?', why: 'Chỉ bật module có sẵn khi thật sự cần (features); còn lại để tắt cho gọn.' },
  { topic: 'du_lieu', ask: 'Anh/chị gửi giúp link Google Sheet (quyền xem) hoặc file Excel đang dùng để tôi nhập dữ liệu cũ vào luôn.', why: 'Đọc file phía AI, ghép cột vào trường rồi import_records theo lô ≤500 dòng.' },
];

export const SETUP_STEPS: readonly string[] = [
  '1. Hỏi từng câu trong interview, MỘT câu mỗi lượt, bằng tiếng Việt dễ hiểu; tóm tắt lại và hỏi khách xác nhận.',
  '2. Có thể gọi list_object_templates để tham khảo mẫu ngành, nhưng dựng theo đúng lời khách.',
  '2b. TRA VAI TRÒ TRƯỚC: get_setup_guide.current.roles là các vai trò CÓ THẬT trong hệ thống. Chỉ dùng đúng tên đó cho menu.roles; vai trò khách nói mà chưa có (vd "Lễ tân") thì hỏi khách: bỏ trống (mọi người thấy) hoặc nhờ quản trị viên tạo ở Cài đặt › Vai trò rồi mới dựng.',
  '3. Gọi propose_workspace MỘT lần: objects (bảng + trường; bước quy trình = trường select có choices theo thứ tự), views (kanban group_by = trường trạng thái), menu, features (module có sẵn cần bật). Gói được dựng ngay theo quyền của khách. (Chỉ khi workspace bật "Yêu cầu duyệt thay đổi do AI": báo khách vào mục "Hoạt động AI" trong Trinity để duyệt.)',
  '4. Kiểm kết quả trả về (status=executed). Nếu lỗi: hỏi lại khách, sửa rồi gọi lại. (Chế độ duyệt: hỏi get_action_status tới khi approved.)',
  '5. Đọc Google Sheet/Excel của khách, ghép cột theo describe_schema, gọi import_records từng lô ≤500 dòng (kèm mapping + source). Bảng có liên kết (vd Khách hàng ← Đơn hàng ← Sản phẩm): gửi CẢ CÁC BẢNG trong một lần import_records với tables (cha trước), bảng con tham chiếu cha bằng khoá nghiệp vụ {"ma_kh": "C001"} hoặc mã chung — một lần ghi hết, không phải gửi lô cha rồi mới gửi lô con.',
  '5b. MÃ CHUNG: mỗi bản ghi tự có mã = tiền tố bảng + số (đơn hàng DH001, khách hàng KH001). Dùng mã khi nói chuyện với khách và để liên kết: find_by_code (tra), get_record/update_record với code, link_records (gắn liên kết), trường kiểu link, hoặc gắn thẻ @DH001 trong ô chữ dài.',
  '6. Xong thì gọi complete_setup để mở CRM cho cả công ty.',
  'Sau khi dựng: đổi cấu trúc vẫn được (update_field, archive_field, update_view…) nhưng Trinity sẽ hiện CẢNH BÁO số bản ghi bị ảnh hưởng; hãy nói rõ với khách và xin xác nhận TRƯỚC khi thực hiện.',
];

export const SETUP_INSTRUCTIONS =
  'DỰNG CRM (hệ thống mới trống): nếu get_setup_guide trả status=chua_dung, hãy CHỦ ĐỘNG phỏng vấn khách theo get_setup_guide.interview (một câu mỗi lượt), ' +
  'xin link Google Sheet/Excel họ đang dùng, rồi dựng MỘT gói bằng propose_workspace (chạy ngay sau khi khách xác nhận bản tóm tắt; tra get_setup_guide.current.roles trước khi đặt vai trò cho menu), ' +
  'nhập dữ liệu bằng import_records (≤500 dòng/lô; nhiều bảng có liên kết thì gửi chung qua tables, con tham chiếu cha bằng khoá nghiệp vụ hoặc mã) và kết thúc bằng complete_setup. ' +
  'Mọi bản ghi có MÃ CHUNG (tiền tố bảng + số, vd SP001, KH012) — dùng mã để tra (find_by_code) và để liên kết (link_records, trường link, @SP001 trong ghi chú). ';
