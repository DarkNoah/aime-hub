import type { StorageThreadType } from '@mastra/core/memory';
import type { UIMessage } from 'ai';
import type { SpeechEvent } from '@aime/shared/audio';
import type {
  ChatSettings,
  ChatUsage,
  RunInput,
  QueuedMessage,
  QueuedMessageDetail,
  UpdateQueuedMessage,
  ThreadStreamStatus,
  ThreadCommandSession,
  ToolInteraction,
  ToolResponse,
} from '@aime/shared/threads';

export type ChatSessionEvent =
  | { type: 'speech'; event: SpeechEvent }
  | { type: 'commands' }
  | {
      type: 'goal';
      objective?: string;
      evaluating?: boolean;
      waitingForUser?: boolean;
    }
  | { type: 'message'; message: UIMessage; active: boolean }
  | { type: 'reconcile'; messages: UIMessage[]; removedMessageIds: string[] }
  | { type: 'status'; status: ThreadStreamStatus; runId: string }
  | { type: 'queue'; count: number; messages?: QueuedMessage[] }
  | { type: 'usage'; usage: ChatUsage }
  | {
      type: 'interaction';
      interaction: ToolInteraction;
      settings: ChatSettings;
    }
  | { type: 'error'; error: unknown; runId?: string };

export type ChatSessionContext = {
  actorId?: string;
  thread: StorageThreadType;
  settings: ChatSettings;
  onEvent: (event: ChatSessionEvent) => void;
};

/** Mastra owns input scheduling. This interface only submits and observes it. */
export interface ChatSession {
  speech?: { readonly active: boolean; stop(): void };
  commands?: {
    list(): ThreadCommandSession[];
    cleanup(sessionId: number): Promise<void>;
  };
  send(input: RunInput): Promise<void>;
  generateTitle(input: RunInput): Promise<string | undefined>;
  compact(): Promise<{ observed: boolean }>;
  clearGoal(): Promise<void>;
  respond(
    interaction: ToolInteraction,
    response: ToolResponse,
    settings: ChatSettings,
  ): Promise<void>;
  retry(settings: ChatSettings): Promise<void>;
  abort(): void;
  clearQueue(): void;
  getQueued(id: string): QueuedMessageDetail;
  updateQueued(id: string, patch: UpdateQueuedMessage): Promise<void>;
  moveQueued(id: string, beforeId: string | null): Promise<void>;
  cancelQueued(id: string): void;
  close(): Promise<void>;
}
