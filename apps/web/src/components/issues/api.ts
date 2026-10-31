import { api, apiErrorCode } from '@/lib/rpc';

export const issueApi = api.issues;
export const issueChanged = () =>
  window.dispatchEvent(new Event('issues-changed'));
export function issueErrorKey(
  error: unknown,
):
  | 'issues.closedError'
  | 'issues.noThreadHint'
  | 'issues.responseRequired'
  | 'issues.accessError'
  | 'issues.error' {
  const code = apiErrorCode(error);
  if (code === 'ISSUE_CLOSED') return 'issues.closedError';
  if (code === 'ISSUE_NO_THREAD') return 'issues.noThreadHint';
  if (code === 'TOOL_RESPONSE_REQUIRED') return 'issues.responseRequired';
  if (
    code === 'NOT_FOUND' ||
    code === 'FORBIDDEN' ||
    code === 'PROJECT_NOT_FOUND'
  )
    return 'issues.accessError';
  return 'issues.error';
}
