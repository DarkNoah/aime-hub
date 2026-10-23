/** A logical subscription; all subscriptions travel over one physical SSE. */
export type RealtimeSubscription = { id: string; url: string };
export type RealtimeEvent = { id: string; event: string; data: string };
export type RealtimeConfiguration = {
  generation: string;
  revision: number;
  subscriptions: RealtimeSubscription[];
};
