import { createHash } from 'node:crypto';
import type { Automation } from '@aime/shared/automations';
import type {
  BrowserPushSubscription,
  NotificationEvent,
} from '@aime/shared/notifications';
import type { NotificationStore, PushRecipient } from './store.js';
import { ThreadError } from '../threads/errors.js';

type Subscriber = {
  userId: string;
  cursor?: string;
  pending: Promise<void>;
  active: boolean;
  queued: number;
  send: (event: NotificationEvent) => void;
  close: () => void;
  authorize: () => Promise<boolean>;
};
export interface PushTransport {
  publicKey: string;
  send(recipient: PushRecipient, id: string): Promise<void>;
}
export class NotificationService {
  private subscribers = new Set<Subscriber>();
  private deliveries = new Set<Promise<void>>();
  constructor(
    private store: NotificationStore,
    private push?: PushTransport,
  ) {}
  config() {
    return { publicKey: this.push?.publicKey ?? null };
  }
  async register(
    userId: string,
    sessionId: string,
    subscription: BrowserPushSubscription,
  ) {
    if (!this.push) throw new ThreadError('PUSH_NOT_CONFIGURED', 503);
    await this.store.subscribe(userId, sessionId, subscription);
  }
  unregister(userId: string, endpoint: string) {
    return this.store.unsubscribe(userId, endpoint);
  }
  get(userId: string, id: string) {
    return this.store.get(userId, id);
  }
  async publish(
    task: Automation,
    status: 'succeeded' | 'failed',
    executionId: string,
  ) {
    const id = createHash('sha256')
      .update(`${task.id}:${executionId}`)
      .digest('hex');
    const url =
      task.separateThread && task.threadCreated
        ? `${task.scope.scope === 'project' ? `/projects/${task.scope.projectId}` : ''}/threads/${encodeURIComponent(task.threadId)}`
        : task.scope.scope === 'project'
          ? `/projects/${task.scope.projectId}/automations`
          : task.scope.scope === 'system'
            ? '/admin/automations'
            : '/automations';
    const added = await this.store.put({
      ownerId: task.createdBy,
      scope: task.scope,
      notification: {
        id,
        taskId: task.id,
        taskName: task.name,
        scope: task.scope,
        status,
        createdAt: new Date().toISOString(),
        url,
      },
    });
    if (!added) return;
    // In-page delivery is unconditional and never waits for a browser push service.
    for (const subscriber of this.subscribers) this.enqueue(subscriber);
    if (task.desktopNotification && this.push) {
      const delivery = this.deliverPush(id)
        .catch(() => {
          console.error('Desktop notification delivery failed');
        })
        .finally(() => this.deliveries.delete(delivery));
      this.deliveries.add(delivery);
    }
  }
  private async deliverPush(id: string) {
    const recipients = await this.store.recipients(id);
    // Bound concurrency; do not log endpoint URLs or browser encryption keys.
    for (let offset = 0; offset < recipients.length; offset += 8) {
      await Promise.all(
        recipients.slice(offset, offset + 8).map(async (recipient) => {
          try {
            await this.push!.send(recipient, id);
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410)
              await this.store.removeExpired(
                recipient.endpoint,
                recipient.sessionId,
              );
            else
              console.error(
                'Desktop notification delivery failed',
                status ?? 'transport',
              );
          }
        }),
      );
    }
  }
  subscribe(
    userId: string,
    cursor: string | undefined,
    send: Subscriber['send'],
    close: Subscriber['close'],
    authorize: Subscriber['authorize'],
  ) {
    const subscriber: Subscriber = {
      userId,
      cursor,
      send,
      close,
      authorize,
      active: true,
      queued: 0,
      pending: Promise.resolve(),
    };
    this.subscribers.add(subscriber);
    this.enqueue(subscriber);
    return () => {
      subscriber.active = false;
      this.subscribers.delete(subscriber);
    };
  }
  private enqueue(subscriber: Subscriber) {
    if (++subscriber.queued > 100) {
      subscriber.active = false;
      this.subscribers.delete(subscriber);
      subscriber.close();
      return;
    }
    subscriber.pending = subscriber.pending
      .then(async () => {
        if (!subscriber.active) return;
        if (!(await subscriber.authorize())) {
          subscriber.close();
          subscriber.active = false;
          this.subscribers.delete(subscriber);
          return;
        }
        let more: boolean;
        do {
          const batch = await this.store.read(
            subscriber.userId,
            subscriber.cursor,
          );
          if (!subscriber.active) return;
          for (const item of batch.items)
            subscriber.send({ type: 'notification', ...item });
          subscriber.cursor = batch.cursor;
          subscriber.send({ type: 'ready', cursor: batch.cursor });
          more = batch.more;
        } while (more && subscriber.active);
      })
      .catch(() => {
        subscriber.active = false;
        this.subscribers.delete(subscriber);
        subscriber.close();
      })
      .finally(() => {
        subscriber.queued--;
      });
  }
  async settled() {
    await Promise.all([
      ...this.deliveries,
      ...[...this.subscribers].map((subscriber) => subscriber.pending),
    ]);
  }
  async close() {
    for (const subscriber of this.subscribers) {
      subscriber.active = false;
      subscriber.close();
    }
    this.subscribers.clear();
    await this.settled();
  }
}
