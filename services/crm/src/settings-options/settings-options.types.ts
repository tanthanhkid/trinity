export const OPTION_SELECT = {
  id: true,
  group_key: true,
  value: true,
  label: true,
  sort_order: true,
  is_active: true,
  is_system: true,
  metadata: true,
} as const;

export interface SettingOptionView {
  id: number;
  group_key: string;
  value: string;
  label: string;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
  metadata: unknown;
}
