import { Router, json } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import type { Auth } from '@aime/auth';
import {
  projectIdSchema,
  projectInputSchema,
  projectMemberSchema,
  projectMemberRoleSchema,
  projectPreferencesSchema,
} from '@aime/shared/projects';
import { adminApiPolicy } from '../../middleware/admin-api.js';
import { threadErrorHandler } from '../threads/routes.js';
import type { ThreadService } from '../threads/service.js';
import type { LanguageModelService } from '../models/language-model.js';
import type { ProjectService } from './service.js';
import { ThreadError } from '../threads/errors.js';
import { requireProjectManager } from './permissions.js';

export function projectRoutes(
  auth: Auth,
  service: ProjectService,
  threads: ThreadService,
  models: LanguageModelService,
  webOrigin: string,
) {
  const router = Router();
  router.use(async (req, res, next) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) return res.status(401).json({ code: 'UNAUTHORIZED' });
    res.locals.userId = session.user.id;
    next();
  });
  router.use(adminApiPolicy(webOrigin), json({ limit: '32kb' }));
  router.param('projectId', (req, _res, next) => {
    if (!projectIdSchema.safeParse(req.params.projectId).success)
      return next(new ThreadError('PROJECT_NOT_FOUND', 404));
    next();
  });
  router.get('/', async (req, res) => {
    const { page, perPage } = z
      .object({
        page: z.coerce.number().int().min(0).max(10000).default(0),
        perPage: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(req.query);
    res.json(await service.list(res.locals.userId, page, perPage));
  });
  router.post('/', async (req, res) => {
    const project = await service.create(
      res.locals.userId,
      projectInputSchema.parse(req.body),
    );
    threads.refreshNavigation(res.locals.userId);
    res.status(201).json(project);
  });
  router.get('/:projectId', async (req, res) =>
    res.json(
      await service.get(res.locals.userId, String(req.params.projectId)),
    ),
  );
  router.patch('/:projectId', async (req, res) => {
    const project = await service.update(
      res.locals.userId,
      String(req.params.projectId),
      projectInputSchema.parse(req.body),
    );
    threads.refreshNavigation();
    res.json(project);
  });
  router.delete('/:projectId', async (req, res) => {
    const id = String(req.params.projectId);
    const { role } = await service.assertMember(res.locals.userId, id);
    if (role !== 'owner') throw new ThreadError('FORBIDDEN', 403);
    await threads.withProjectDeletion(id, () =>
      service.remove(res.locals.userId, id),
    );
    res.status(204).end();
  });
  router.get('/:projectId/preferences', async (req, res) =>
    res.json(
      await service.preferences(
        res.locals.userId,
        String(req.params.projectId),
      ),
    ),
  );
  router.put('/:projectId/preferences', async (req, res) => {
    const id = String(req.params.projectId);
    requireProjectManager(
      (await service.assertMember(res.locals.userId, id)).role,
    );
    const input = projectPreferencesSchema.parse(req.body);
    if (input.model)
      await models.getLanguageModel(res.locals.userId, input, id);
    res.json(await service.savePreferences(res.locals.userId, id, input));
  });
  router.get('/:projectId/members', async (req, res) =>
    res.json(
      await service.members(res.locals.userId, String(req.params.projectId)),
    ),
  );
  router.get('/:projectId/users', async (req, res) =>
    res.json(
      await service.searchUsers(
        res.locals.userId,
        String(req.params.projectId),
        z.string().trim().max(100).default('').parse(req.query.q),
      ),
    ),
  );
  router.post('/:projectId/members', async (req, res) => {
    const member = await service.addMember(
      res.locals.userId,
      String(req.params.projectId),
      projectMemberSchema.parse(req.body),
    );
    threads.refreshNavigation(member.id);
    res.status(201).json(member);
  });
  router.patch('/:projectId/members/:userId', async (req, res) => {
    const { role } = projectMemberRoleSchema.parse(req.body);
    await service.changeMember(
      res.locals.userId,
      String(req.params.projectId),
      String(req.params.userId),
      role,
    );
    threads.refreshNavigation(String(req.params.userId));
    res.status(204).end();
  });
  router.delete('/:projectId/members/:userId', async (req, res) => {
    const id = String(req.params.projectId);
    const userId = String(req.params.userId);
    await service.changeMember(res.locals.userId, id, userId);
    threads.invalidateProject(id, userId);
    res.status(204).end();
  });
  router.use(threadErrorHandler);
  return router;
}
