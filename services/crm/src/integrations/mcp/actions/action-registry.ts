import type { ActionToolDef } from './action-types';
import { addNoteAction, assignContactAction, createContactAction, updateStageAction } from './action-contact-tools';
import { createRecordAction, updateRecordAction } from './action-record-tools';
import { archiveRecordAction } from './action-archive-record';
import { addFieldAction, archiveFieldAction, updateFieldAction } from './action-field-tools';
import { createObjectAction, createObjectsAction, updateObjectAction } from './action-structure-tools';
import { installTemplateAction } from './action-template-tools';
import { createTaskAction } from './action-task-tool';
import { createViewAction, setMenuAction, updateViewAction } from './action-view-tools';
import { proposeWorkspaceAction } from './action-workspace';
import { importRecordsAction } from './action-import';
import { restoreVersionAction } from './action-version-tools';
import { linkRecordsAction } from './action-link-tools';
import { createSocialPostAction, importSocialPostsAction, publishSocialDraftAction, rescheduleSocialPostAction, retrySocialTargetAction, updateScheduledPostAction } from './action-social-tools';

/** TOÀN BỘ thao tác ghi mà AI được ĐỀ XUẤT. Cố ý KHÔNG có xoá / xuất file / quản trị — thêm tool ghi mới = thêm vào đây. */
export const ACTION_TOOLS: readonly ActionToolDef[] = [createContactAction, addNoteAction, updateStageAction, createTaskAction, assignContactAction, createRecordAction, updateRecordAction, archiveRecordAction,
  createObjectsAction, createObjectAction, updateObjectAction, addFieldAction, updateFieldAction, archiveFieldAction, installTemplateAction,
  proposeWorkspaceAction, importRecordsAction, linkRecordsAction, createViewAction, updateViewAction, setMenuAction, restoreVersionAction,
  createSocialPostAction, retrySocialTargetAction, updateScheduledPostAction, rescheduleSocialPostAction, publishSocialDraftAction, importSocialPostsAction];

export const actionToolByName = (name: string): ActionToolDef | undefined => ACTION_TOOLS.find((t) => t.name === name);
