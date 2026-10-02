import type { ProjectRole } from '@aime/shared/projects';
import { ThreadError } from '../threads/errors.js';

export function requireProjectManager(role: ProjectRole) {
  if (role === 'member') throw new ThreadError('FORBIDDEN', 403);
}

export function requireMemberChange(
  actor: ProjectRole,
  target: ProjectRole,
  next?: ProjectRole,
) {
  requireProjectManager(actor);
  if (target === 'owner' || next === 'owner')
    throw new ThreadError('PROJECT_OWNER_REQUIRED', 409);
  if (actor === 'admin' && (target !== 'member' || (next && next !== 'member')))
    throw new ThreadError('FORBIDDEN', 403);
}
