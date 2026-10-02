import express from 'express';
import helmet from 'helmet';
import type { Auth } from '@aime/auth';
import { authRoutes } from './modules/auth/routes.js';
import { requireAdmin } from './modules/auth/require-admin.js';
import { healthRoutes } from './modules/health/routes.js';
import { providerRoutes } from './modules/providers/routes.js';
import type { ProviderService } from './modules/providers/service.js';
import { settingsRoutes } from './modules/settings/routes.js';
import {
  adminApiPolicy,
  adminApiErrorHandler,
} from './middleware/admin-api.js';
import { errorHandler } from './middleware/error-handler.js';
import { modelRoutes } from './modules/models/routes.js';
import { threadRoutes } from './modules/threads/routes.js';
import type { ThreadService } from './modules/threads/service.js';
import type { LanguageModelService } from './modules/models/language-model.js';
import { projectRoutes } from './modules/projects/routes.js';
import type { ProjectService } from './modules/projects/service.js';

export function createApp(
  auth: Auth,
  providers?: { service: ProviderService; webOrigin: string },
  chat?: {
    threads: ThreadService;
    models: LanguageModelService;
    webOrigin: string;
    projects?: ProjectService;
  },
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use('/api', healthRoutes());
  // Better Auth owns its request bodies and authorization for /api/auth/admin/*.
  app.use('/api', authRoutes(auth));
  if (providers) app.use('/api', modelRoutes(auth, providers.service));
  if (chat)
    app.use(
      '/api/threads',
      threadRoutes(auth, chat.threads, chat.models, chat.webOrigin),
    );
  if (chat?.projects)
    app.use(
      '/api/projects',
      projectRoutes(
        auth,
        chat.projects,
        chat.threads,
        chat.models,
        chat.webOrigin,
      ),
    );
  app.use('/api/admin', requireAdmin(auth));
  if (providers) {
    app.use(
      '/api/admin',
      adminApiPolicy(providers.webOrigin),
      express.json({ limit: '128kb' }),
    );
    app.use('/api/admin', providerRoutes(providers.service));
    app.use('/api/admin/settings', settingsRoutes(providers.service));
    app.use('/api/admin', adminApiErrorHandler);
  }
  app.use('/api/admin', (_req, res) =>
    res.status(501).json({ message: '该管理模块尚未实现' }),
  );
  app.use((_req, res) => res.status(404).json({ message: '接口不存在' }));
  app.use(errorHandler);
  return app;
}
