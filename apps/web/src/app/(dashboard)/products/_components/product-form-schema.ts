import { z } from "zod"

/**
 * Schema form tạo/sửa sản phẩm — mirror ranh giới validate của
 * `CreateProductDto`/`UpdateProductDto` phía BE.
 *
 * Khung khai báo chung đa ngành: `category_id` + `attributes` (thuộc tính
 * động, render theo `ProductAttributeDef` của danh mục đã chọn, xem
 * `product-form-dialog.tsx`). `project_id` là OPTIONAL.
 *
 * `attributes` KHÔNG có shape tĩnh trong zod — giá trị phụ thuộc HOÀN TOÀN vào
 * danh mục đang chọn (dynamic theo `ProductAttributeDef[]`), validate THẬT SỰ
 * nằm ở BE (`validateProductAttributes`, whitelist theo `key`/`type`). Form
 * chỉ tự kiểm "thiếu field bắt buộc" TRƯỚC khi submit (`validateAttributesOrErrors`)
 * để không gửi lên rồi mới biết lỗi — không thay thế validate BE.
 */
export const productFormSchema = z.object({
  code: z
    .string()
    .min(2, "Mã sản phẩm tối thiểu 2 ký tự")
    .max(64, "Mã sản phẩm tối đa 64 ký tự")
    .regex(/^[A-Za-z0-9_-]+$/, "Chỉ chứa chữ, số, gạch ngang và gạch dưới"),
  name: z.string().min(2, "Tên sản phẩm tối thiểu 2 ký tự").max(255),
  // Sentinel rỗng "" = KHÔNG thuộc dự án nào (optional).
  project_id: z.string().optional(),
  // Sentinel rỗng "" = CHƯA phân loại danh mục.
  category_id: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  description: z.string().max(2000, "Mô tả tối đa 2000 ký tự").optional(),
  price: z
    .string()
    .optional()
    .refine((v) => !v || Number(v) >= 0, { message: "Giá không được âm" })
    // Khớp trần BE (`PRODUCT_PRICE_CEILING` = 1.000 tỷ) — ô tiền cho gõ tới 15 chữ số.
    .refine((v) => !v || Number(v) <= 1_000_000_000_000, {
      message: "Giá tối đa 1.000.000.000.000 ₫",
    }),
  brand: z.string().max(255).optional(),
  // Thông báo tiếng Việt: ô này nay CÓ chỗ hiện lỗi nên message
  // mặc định tiếng Anh của zod sẽ lọt ra màn hình nếu không đặt.
  color: z.string().max(32, "Màu tối đa 32 ký tự").optional(),
  tags: z.string().optional(),
  is_featured: z.boolean(),
  image_url: z.string().max(2048).optional(),
  is_active: z.boolean(),
})

export type ProductForm = z.infer<typeof productFormSchema>

/** Tách text phân tách bởi dấu phẩy thành mảng — bỏ phần tử rỗng, trim. */
export function commaToArray(text: string | undefined): string[] {
  if (!text) return []
  return text
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** Màu mở sẵn của bảng chọn khi ô đang trống / không phải mã hex hợp lệ. */
export const COLOR_PICKER_FALLBACK = "#000000"

/**
 * Chuẩn hoá giá trị ô "Màu (hex/tên)" về dạng `#rrggbb` để NẠP cho
 * `<input type="color">`.
 *
 * `<input type="color">` CHỈ hiểu đúng 6 chữ số hex — mọi giá trị khác bị
 * trình duyệt ép thầm về `#000000`. Trường này lại cố ý nhận CẢ tên màu CSS
 * ("red", "teal") nên hàm này KHÔNG phải nguồn sự thật của form: nó chỉ quyết
 * định bảng chọn mở ở màu nào. Giá trị LƯU vẫn nguyên chuỗi người dùng gõ
 * (xem `handleSubmit`) ⇒ contract gửi BE không đổi.
 *
 * Trả về `COLOR_PICKER_FALLBACK` thay vì ném lỗi: ô đang gõ dở ("#0075") là
 * trạng thái BÌNH THƯỜNG, không được làm vỡ form.
 */
export function toPickerHex(value: string | undefined | null): string {
  if (!value) return COLOR_PICKER_FALLBACK
  const v = value.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(v)) return v
  // Dạng rút gọn 3 chữ số: #0a7 → #00aa77 (CSS hiểu, thẻ color thì không).
  if (/^#[0-9a-f]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
  }
  return COLOR_PICKER_FALLBACK
}
