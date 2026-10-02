import { ThreadError } from './errors.js';

export function threadScope(resourceId: string) {
  if (resourceId.startsWith('user:') && resourceId.length > 5)
    return {
      type: 'user' as const,
      userId: resourceId.slice(5),
      projectId: undefined,
    };
  if (/^project:[a-zA-Z0-9_-]{16}$/.test(resourceId))
    return {
      type: 'project' as const,
      projectId: resourceId.slice(8),
      userId: undefined,
    };
  throw new ThreadError('THREAD_NOT_FOUND', 404);
}
