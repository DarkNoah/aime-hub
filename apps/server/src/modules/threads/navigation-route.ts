import type { Auth } from '@aime/auth';
import type { ThreadService } from './service.js';
import { eventStream } from './event-stream.js';

export function streamThreadNavigation(
  auth: Auth,
  service: ThreadService,
  request: Request,
  userId: string,
) {
  return eventStream(
    request.signal,
    (send, close) =>
      service.subscribeNavigation(
        userId,
        (event) => send('navigation', event),
        close,
      ),
    async () => {
      const session = await auth.api.getSession({ headers: request.headers });
      return !session || session.user.id !== userId ? 'expired' : undefined;
    },
  );
}
