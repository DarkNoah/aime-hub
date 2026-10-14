import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { FILE_UPLOAD_CHUNK_SIZE, fileUploadSchema } from '@aime/shared/files';
import type { Auth } from '@aime/auth';
import { requireSession, type HttpEnv } from '../../http.js';
import { ThreadError } from '../threads/errors.js';
import type { ThreadService } from '../threads/service.js';
import { fileError } from './paths.js';
import { uploadDestination, publishUpload } from './upload-workspace.js';
import { FileUploads } from './uploads.js';

export function uploadRoutes(
  auth: Auth,
  service: ThreadService,
  webOrigins: readonly string[],
) {
  const router = new Hono<HttpEnv>();
  const uploads = new FileUploads();
  router.use('*', requireSession(auth), async (c, next) => {
    if (!webOrigins.includes(c.req.header('Origin') ?? ''))
      throw new ThreadError('FORBIDDEN', 403);
    await service.getThread(c.get('userId'), c.req.param('threadId')!);
    await next();
  });
  router.use(
    '*',
    bodyLimit({
      maxSize: FILE_UPLOAD_CHUNK_SIZE,
      onError: (c) => c.json({ code: 'FILE_UPLOAD_CHUNK' }, 413),
    }),
  );
  router.post('/', bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const owner = {
      userId: c.get('userId'),
      threadId: c.req.param('threadId')!,
    };
    const input = fileUploadSchema.parse(await c.req.json());
    await service
      .withWorkspaceFiles(
        owner.userId,
        owner.threadId,
        (root) => uploadDestination(root, input.path),
        input.scope,
      )
      .catch(fileError);
    return c.json(await uploads.create(owner, input));
  });
  router.put('/:uploadId', async (c) => {
    const owner = {
      userId: c.get('userId'),
      threadId: c.req.param('threadId')!,
    };
    const offset = c.req.query('offset');
    if (!offset || !/^\d+$/.test(offset))
      throw new ThreadError('FILE_UPLOAD_CHUNK');
    return c.json(
      await uploads.chunk(
        owner,
        c.req.param('uploadId'),
        Number(offset),
        new Uint8Array(await c.req.arrayBuffer()),
      ),
    );
  });
  router.post('/:uploadId/complete', async (c) => {
    const owner = {
      userId: c.get('userId'),
      threadId: c.req.param('threadId')!,
    };
    return c.json(
      await uploads
        .complete(owner, c.req.param('uploadId'), (input, source) =>
          service.withWorkspaceFiles(
            owner.userId,
            owner.threadId,
            (root) => publishUpload(root, input.path, source),
            input.scope,
          ),
        )
        .catch(fileError),
    );
  });
  router.delete('/:uploadId', async (c) =>
    c.json(
      await uploads.cancel(
        { userId: c.get('userId'), threadId: c.req.param('threadId')! },
        c.req.param('uploadId'),
      ),
    ),
  );
  return router;
}
