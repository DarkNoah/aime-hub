import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import type { Auth } from '@aime/auth';
import { requireSession, type HttpEnv } from '../../http.js';
import type { ThreadService } from '../threads/service.js';
import { fileError } from './paths.js';
import {
  localWorkspaceFile,
  previewWorkspaceFile,
  streamWorkspaceFile,
} from './workspace-files.js';

export function fileRoutes(auth: Auth, service: ThreadService) {
  const router = new Hono<HttpEnv>();
  router.get('/raw', requireSession(auth), async (c, next) => {
    try {
      const userId = c.get('userId');
      const threadId = c.req.param('threadId')!;
      const path = z.string().max(2048).default('').parse(c.req.query('path'));
      return await service.withWorkspaceFiles(
        userId,
        threadId,
        async (root) => {
          const info = await previewWorkspaceFile(root, path);
          const absolute = await localWorkspaceFile(root, path);
          c.header('Content-Type', info.mime);
          c.header('X-Content-Type-Options', 'nosniff');
          c.header('Content-Security-Policy', "default-src 'none'; sandbox");
          c.header('Cache-Control', 'no-store');
          if (
            c.req.query('download') === '1' ||
            info.kind === 'binary' ||
            info.kind === 'text'
          ) {
            const name = encodeURIComponent(path.split('/').at(-1)!).replace(
              /['()*]/g,
              (value) => `%${value.charCodeAt(0).toString(16)}`,
            );
            c.header(
              'Content-Disposition',
              `attachment; filename="download"; filename*=UTF-8''${name}`,
            );
          }
          if (absolute)
            return serveStatic<HttpEnv>({
              path: absolute,
              onFound: (_path, context) => {
                context.header('Content-Type', info.mime);
              },
            })(c, next);
          c.header('Accept-Ranges', 'bytes');
          let start = 0;
          let end = info.size - 1;
          const range = c.req.header('Range');
          if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!match || (!match[1] && !match[2])) {
              c.header('Content-Range', `bytes */${info.size}`);
              return c.body(null, 416);
            }
            start = match[1]
              ? Number(match[1])
              : Math.max(0, info.size - Number(match[2]));
            end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
            if (
              !Number.isSafeInteger(start) ||
              !Number.isSafeInteger(end) ||
              start > end ||
              start >= info.size
            ) {
              c.header('Content-Range', `bytes */${info.size}`);
              return c.body(null, 416);
            }
            c.status(206);
            c.header('Content-Range', `bytes ${start}-${end}/${info.size}`);
          }
          c.header('Content-Length', String(Math.max(0, end - start + 1)));
          // Open a separate provider for the stream, and keep it alive until the
          // final chunk or client cancellation, rather than closing with headers.
          return stream(c, (output) =>
            service.withWorkspaceFiles(userId, threadId, (filesystem) =>
              streamWorkspaceFile(
                filesystem,
                path,
                (chunk) => output.write(chunk),
                () => output.aborted,
                start,
                end,
              ),
            ),
          );
        },
      );
    } catch (error) {
      fileError(error);
    }
  });
  return router;
}
