import type {
  RealtimeEvent,
  RealtimeSubscription,
} from '@aime/shared/realtime';

export type WorkerRequest =
  | { type: 'update'; sessionId: string; subscriptions: RealtimeSubscription[] }
  | { type: 'pong' | 'close' };
export type WorkerResponse =
  | { type: 'event'; event: RealtimeEvent }
  | { type: 'ready' | 'ping' | 'reconnect' };

export type RealtimeBridge = {
  update: (subscriptions: RealtimeSubscription[]) => void;
  close: () => void;
};
