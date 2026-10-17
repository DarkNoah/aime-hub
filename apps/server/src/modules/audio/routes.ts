import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Auth } from '@aime/auth';
import {
  createVoiceSchema,
  generateVoiceSchema,
  updateVoiceSchema,
} from '@aime/shared/audio';
import { requireSession, type HttpEnv } from '../../http.js';
import { maxReferenceAudioBytes } from '../../mastra/providers/audio-data.js';
import { fileError, filePath } from '../files/paths.js';
import { ThreadError } from '../threads/errors.js';
import { normalizeVoiceAudio } from './convert.js';
import type { AudioService } from './service.js';
import { errorHandler } from '../../middleware/error-handler.js';

export function audioRoutes(
  auth: Auth,
  service: AudioService,
  webOrigins: readonly string[],
) {
  const router = new Hono<HttpEnv>();
  router.onError((error, context) => {
    try {
      fileError(error);
    } catch (mapped) {
      return errorHandler(mapped as Error, context);
    }
  });
  router.use('*', requireSession(auth), async (c, next) => {
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      !webOrigins.includes(c.req.header('Origin') ?? '')
    )
      throw new ThreadError('FORBIDDEN', 403);
    try {
      await next();
    } catch (error) {
      fileError(error);
    }
  });
  router.use(
    '*',
    bodyLimit({
      maxSize: maxReferenceAudioBytes + 256000,
      onError: (c) => c.json({ code: 'AUDIO_TOO_LARGE' }, 413),
    }),
  );
  router.get('/voices', async (c) =>
    c.json({ voices: await service.voices.list(c.get('userId')) }),
  );
  router.get('/voices/raw', async (c, next) => {
    const voice = await service.voices.get(
      c.get('userId'),
      c.req.query('path') ?? '',
    );
    const path = await filePath(service.voices.root, voice.audioPath);
    c.header('Content-Type', 'audio/wav');
    c.header('Cache-Control', 'no-store');
    const response = await serveStatic<HttpEnv>({
      path,
      onFound: (_path, context) => {
        context.header('Content-Type', 'audio/wav');
      },
    })(c, next);
    // serveStatic creates its Response before onFound; set the returned headers too.
    if (response instanceof Response)
      response.headers.set('Content-Type', 'audio/wav');
    return response;
  });
  router.post('/voices', async (c) => {
    const form = await c.req.formData();
    const data = createVoiceSchema.parse({
      name: form.get('name'),
      description: form.get('description') ?? '',
      text: form.get('text'),
      shared: form.get('shared') === 'true',
    });
    const file = form.get('audio');
    if (!(file instanceof File)) throw new ThreadError('AUDIO_REQUIRED');
    const audio = await normalizeVoiceAudio(
      Buffer.from(await file.arrayBuffer()),
      c.req.raw.signal,
    );
    c.req.raw.signal.throwIfAborted();
    return c.json(await service.voices.create(c.get('userId'), data, audio));
  });
  router.post('/voices/generate', async (c) =>
    c.json(
      await service.generateVoice(
        c.get('userId'),
        generateVoiceSchema.parse(await c.req.json()),
        c.req.raw.signal,
      ),
    ),
  );
  router.patch('/voices', async (c) =>
    c.json(
      await service.voices.update(
        c.get('userId'),
        updateVoiceSchema.parse(await c.req.json()),
      ),
    ),
  );
  router.delete('/voices', async (c) => {
    await service.voices.remove(c.get('userId'), c.req.query('path') ?? '');
    return c.json({ ok: true });
  });
  router.post('/transcribe', async (c) => {
    const form = await c.req.formData();
    const file = form.get('audio');
    if (!(file instanceof File)) throw new ThreadError('AUDIO_REQUIRED');
    const audio = await normalizeVoiceAudio(
      Buffer.from(await file.arrayBuffer()),
      c.req.raw.signal,
    );
    return c.json(
      await service.transcribe(audio, { signal: c.req.raw.signal }),
    );
  });
  return router;
}
