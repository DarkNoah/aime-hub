import type { ThreadNavigationEvent } from '@aime/shared/threads';
import { ThreadError } from './errors.js';

type Subscriber = {
  userId: string;
  active: boolean;
  pending: Promise<void>;
  queued: number;
  projects: Set<string>;
  send: (event: ThreadNavigationEvent) => void;
  close: () => void;
};

// Serializes snapshot creation, permission checks and deltas for each connection.
export class ThreadNavigationFeed {
  private subscribers = new Set<Subscriber>();
  constructor(
    private snapshot: (userId: string) => Promise<ThreadNavigationEvent>,
    private authorize: (userId: string, projectId: string) => Promise<unknown>,
  ) {}

  subscribe(userId: string, send: Subscriber['send'], close: () => void) {
    const subscriber: Subscriber = {
      userId,
      send,
      close,
      active: true,
      pending: Promise.resolve(),
      queued: 0,
      projects: new Set(),
    };
    this.subscribers.add(subscriber);
    this.enqueue(subscriber, () => this.snapshot(userId));
    return () => this.drop(subscriber);
  }

  private drop(subscriber: Subscriber) {
    subscriber.active = false;
    this.subscribers.delete(subscriber);
  }

  private enqueue(
    subscriber: Subscriber,
    event: () => Promise<ThreadNavigationEvent | null>,
  ) {
    if (++subscriber.queued > 500) {
      this.drop(subscriber);
      subscriber.close();
      return;
    }
    subscriber.pending = subscriber.pending
      .then(async () => {
        if (!subscriber.active) return;
        const value = await event();
        if (subscriber.active && value) {
          if (value.type === 'snapshot')
            subscriber.projects = new Set(
              value.projects.map((project) => project.id),
            );
          if (value.type === 'project-removed')
            subscriber.projects.delete(value.projectId);
          subscriber.send(value);
        }
      })
      .catch(() => {
        this.drop(subscriber);
        subscriber.close();
      })
      .finally(() => {
        subscriber.queued--;
      });
  }

  publish(resourceId: string, event: ThreadNavigationEvent) {
    for (const subscriber of this.subscribers) {
      if (resourceId.startsWith('user:')) {
        if (resourceId !== `user:${subscriber.userId}`) continue;
        this.enqueue(subscriber, async () => event);
      } else if (resourceId.startsWith('project:')) {
        const projectId = resourceId.slice('project:'.length);
        this.enqueue(subscriber, async () => {
          try {
            await this.authorize(subscriber.userId, projectId);
            return event;
          } catch (error) {
            if (!(error instanceof ThreadError) || error.status !== 404)
              throw error;
            return subscriber.projects.has(projectId)
              ? { type: 'project-removed', projectId }
              : null;
          }
        });
      }
    }
  }

  refresh(userId?: string) {
    for (const subscriber of this.subscribers) {
      if (userId && subscriber.userId !== userId) continue;
      this.enqueue(subscriber, () => this.snapshot(subscriber.userId));
    }
  }

  close() {
    for (const subscriber of this.subscribers) {
      this.drop(subscriber);
      subscriber.close();
    }
  }
}
