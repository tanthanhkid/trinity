/**
 * derive giai đoạn hiển thị của Contact.
 *
 * Giai đoạn hiển thị CHỈ gồm:
 *   1. `contact.stage.label` (chọn tay).
 *   2. Nếu null → fallback "Mới".
 */

interface StageShape {
  value?: string | null;
  label?: string | null;
}

interface ContactStageInput {
  stage?: StageShape | null;
}

export interface DerivedContactStage {
  source: 'stage' | 'default';
  label: string;
}

const DEFAULT_LABEL = 'Mới';

export function deriveContactStage(
  contact: ContactStageInput,
): DerivedContactStage {
  const pre = contact.stage;
  if (pre?.label) {
    return { source: 'stage', label: pre.label };
  }
  return { source: 'default', label: DEFAULT_LABEL };
}
