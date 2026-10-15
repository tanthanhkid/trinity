import { CLINIC_TEMPLATE } from './clinic.template';
import { EDUCATION_CENTER_TEMPLATE } from './education-center.template';
import { REAL_ESTATE_TEMPLATE } from './real-estate.template';
import { RETAIL_SERVICE_TEMPLATE } from './retail-service.template';
import type { CustomObjectTemplate } from './template-types';

export const CUSTOM_OBJECT_TEMPLATES: readonly CustomObjectTemplate[] = [
  EDUCATION_CENTER_TEMPLATE,
  REAL_ESTATE_TEMPLATE,
  RETAIL_SERVICE_TEMPLATE,
  CLINIC_TEMPLATE,
];

export function findTemplate(key: string): CustomObjectTemplate | undefined {
  return CUSTOM_OBJECT_TEMPLATES.find((t) => t.key === key);
}

export type { CustomObjectTemplate, SampleRecord, TemplateField, TemplateObject } from './template-types';
