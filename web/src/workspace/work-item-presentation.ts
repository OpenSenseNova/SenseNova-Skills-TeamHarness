import type { WorkItem } from '../api/client';

export function isWorkItemSubmissionPending(
  workItem: Pick<WorkItem, 'lifecycleStatus' | 'currentSubmission'>,
): boolean {
  return workItem.lifecycleStatus === 'open' && workItem.currentSubmission !== null;
}
