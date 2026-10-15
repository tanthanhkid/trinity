import type { FieldType, SelectChoice } from '../field-types';

/**
 * Mẫu tính năng dựng sẵn: một bộ thực thể + trường + liên kết áp 1 lần bằng
 * `POST /custom-objects/templates/:key/apply`. Mẫu là DỮ LIỆU thuần (không mã chạy), mọi biểu thức công thức được
 * kiểm bằng đúng parser của hệ thống (test khoá), liên kết trỏ nhau bằng KHOÁ thực thể trong mẫu.
 */
export interface TemplateField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  is_unique?: boolean;
  is_title?: boolean;
  show_in_list?: boolean;
  help_text?: string;
  choices?: SelectChoice[];
  /** relation: khoá thực thể đích TRONG mẫu (hoặc 'contact' = Danh bạ). */
  relation?: string;
  multiple?: boolean;
  expression?: string;
  format?: 'number' | 'currency' | 'percent';
  decimals?: number;
}

export interface TemplateObject {
  key: string;
  label: string;
  label_plural: string;
  icon: string;
  description: string;
  fields: TemplateField[];
}

/** Bản ghi mẫu GIẢ: `data` dùng khoá trường; liên kết ghi bằng `ref` = chỉ số (0-based) bản ghi mẫu cùng thực thể đích. */
export interface SampleRecord {
  object: string;
  data: Record<string, unknown>;
  refs?: Record<string, number | number[]>;
}

export interface CustomObjectTemplate {
  key: string;
  label: string;
  description: string;
  objects: TemplateObject[];
  /** Dữ liệu mẫu (giả), đủ để dùng thử công thức. */
  samples: (todayVn: string) => SampleRecord[];
}
