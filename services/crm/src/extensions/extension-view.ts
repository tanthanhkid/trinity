import type { Extension, ExtensionVersion } from '@prisma/client';
import type { ExtManifest } from './manifest';

export type ExtensionStatus = 'draft' | 'approved' | 'active' | 'disabled';
export type ReviewStatus = 'draft' | 'approved' | 'rejected';

export interface VersionView {
  version: number;
  review_status: ReviewStatus;
  review_note: string | null;
  note: string | null;
  manifest: ExtManifest;
  created_by: number;
  reviewed_by: number | null;
  reviewed_at: string | null;
  created_at: string;
  /** Chỉ có khi hỏi chi tiết một phiên bản. */
  code?: string;
}

export interface ExtensionView {
  id: number;
  key: string;
  kind: string;
  name: string;
  description: string;
  status: ExtensionStatus;
  active_version: number | null;
  latest_version: number;
  disabled_reason: string | null;
  consecutive_failures: number;
  created_by: number;
  created_at: string;
  updated_at: string;
}

export const toVersionView = (v: ExtensionVersion, withCode = false): VersionView => ({
  version: v.version,
  review_status: v.review_status as ReviewStatus,
  review_note: v.review_note,
  note: v.note,
  manifest: v.manifest as unknown as ExtManifest,
  created_by: v.created_by,
  reviewed_by: v.reviewed_by,
  reviewed_at: v.reviewed_at?.toISOString() ?? null,
  created_at: v.created_at.toISOString(),
  ...(withCode ? { code: v.code } : {}),
});

export function toExtensionView(e: Extension, activeVersion: number | null): ExtensionView {
  return {
    id: e.id,
    key: e.key,
    kind: e.kind,
    name: e.name,
    description: e.description,
    status: e.status as ExtensionStatus,
    active_version: activeVersion,
    latest_version: e.latest_version,
    disabled_reason: e.disabled_reason,
    consecutive_failures: e.consecutive_failures,
    created_by: e.created_by,
    created_at: e.created_at.toISOString(),
    updated_at: e.updated_at.toISOString(),
  };
}
