import { Router } from 'express';
import { z } from 'zod';
import { fileMutationSchema } from '@aime/shared/files';
import type { ThreadService } from '../threads/service.js';
import { fileError, filePath } from './paths.js';
import { listFiles, mutateFile, previewFile } from './service.js';
import { searchFiles } from './search.js';

const pathQuery = z.object({ path: z.string().max(2048).default('') });

// Mounted inside threadRoutes, after its session and same-origin middleware.
export function fileRoutes(service: ThreadService) {
  const router = Router({ mergeParams: true });
  router.use(async (req, res, next) => {
    res.locals.workspace = await service.workspaceDirectory(
      res.locals.userId,
      String(req.params.threadId),
    );
    next();
  });
  router.get('/', async (req, res) => {
    res.json(
      await listFiles(res.locals.workspace, pathQuery.parse(req.query).path),
    );
  });
  router.get('/search', async (req, res) => {
    const { query } = z
      .object({
        query: z.string().trim().min(1).max(200),
      })
      .parse(req.query);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.on('close', cancel);
    try {
      res.json(
        await searchFiles(res.locals.workspace, query, controller.signal),
      );
    } finally {
      res.off('close', cancel);
    }
  });
  router.get('/preview', async (req, res) => {
    res.json(
      await previewFile(res.locals.workspace, pathQuery.parse(req.query).path),
    );
  });
  router.get('/raw', async (req, res, next) => {
    const { path } = pathQuery.parse(req.query);
    const info = await previewFile(res.locals.workspace, path);
    const absolute = await filePath(res.locals.workspace, path);
    res.set({
      'Content-Type': info.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'no-store',
    });
    // Express provides Range/HEAD support for seeking in audio and video.
    if (
      req.query.download === '1' ||
      info.kind === 'binary' ||
      info.kind === 'text'
    )
      res.attachment(path.split('/').at(-1));
    // attachment() infers MIME from the extension; enforce our classification again.
    res.type(info.mime);
    res.sendFile(
      absolute,
      { dotfiles: 'allow', cacheControl: false },
      (error) => {
        if (error) next(error);
      },
    );
  });
  router.post('/', async (req, res) => {
    res.json(
      await mutateFile(
        res.locals.workspace,
        fileMutationSchema.parse(req.body),
      ),
    );
  });
  router.use(((error, _req, _res, next) => {
    try {
      fileError(error);
    } catch (mapped) {
      next(mapped);
    }
  }) satisfies import('express').ErrorRequestHandler);
  return router;
}
