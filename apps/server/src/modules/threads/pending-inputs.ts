import type { SendAgentMessageResult } from '@mastra/core/agent';
import type { MastraModelOutput } from '@mastra/core/stream';
import {
  runInputSchema,
  type QueuedMessage,
  type QueuedMessageDetail,
  type RunInput,
  type UpdateQueuedMessage,
} from '@aime/shared/threads';
import { ThreadError } from './errors.js';

type Draft = { input: RunInput; signalId?: string; failed?: boolean };
type Submit = () => SendAgentMessageResult<unknown>;
const textOf = (input: RunInput) =>
  input.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');

/** UI copies of native submissions. No timer, execution loop or persisted queue. */
export class PendingInputs {
  private drafts = new Map<string, Draft>();
  constructor(
    private prepare: (input: RunInput) => Promise<Submit>,
    private cancel: (signalIds: string[]) => { cancelledSignalIds: string[] },
    private changed: () => void,
    private onWake: (output: MastraModelOutput<unknown>) => void,
  ) {}

  summaries(): QueuedMessage[] {
    return [...this.drafts.values()].map(({ input, failed }) => ({
      id: input.id,
      text: textOf(input).slice(0, 200),
      isImmediate: input.isImmediate,
      createdAt: input.createdAt!,
      ...(failed ? { failed: true } : {}),
    }));
  }

  private get(id: string) {
    const draft = this.drafts.get(id);
    if (!draft) throw new ThreadError('QUEUED_MESSAGE_NOT_FOUND', 409);
    return draft;
  }

  detail(id: string): QueuedMessageDetail {
    const { input } = this.get(id);
    return {
      id,
      text: textOf(input),
      isImmediate: input.isImmediate,
      hasAttachments: input.parts.some((part) => part.type === 'file'),
    };
  }

  consumed(signalId: string) {
    for (const [id, draft] of this.drafts) {
      if (draft.signalId !== signalId) continue;
      this.drafts.delete(id);
      this.changed();
      break;
    }
  }

  private submit(input: RunInput, submit: Submit, retainFailure: boolean) {
    const draft: Draft = { input };
    let result: SendAgentMessageResult<unknown>;
    try {
      result = submit();
    } catch (error) {
      if (retainFailure) {
        draft.failed = true;
        this.drafts.set(input.id, draft);
      }
      this.changed();
      return Promise.reject(error);
    }
    draft.signalId = result.signal.id;
    this.drafts.set(input.id, draft);
    return result.accepted
      .then((accepted) => {
        if (accepted.action === 'blocked')
          throw new ThreadError('TOOL_RESPONSE_REQUIRED', 409);
        if (accepted.action !== 'wake' && accepted.action !== 'deliver')
          throw new ThreadError('CHAT_FAILED', 502);
        if (accepted.action === 'wake' && this.drafts.get(input.id) === draft)
          this.drafts.delete(input.id);
        if (accepted.action === 'wake') this.onWake(accepted.output);
        this.changed();
        return accepted;
      })
      .catch((error: unknown) => {
        if (this.drafts.get(input.id) === draft) {
          if (retainFailure) {
            draft.signalId = undefined;
            draft.failed = true;
          } else this.drafts.delete(input.id);
        }
        this.changed();
        throw error;
      });
  }

  async send(input: RunInput) {
    const normalized = {
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    return this.submit(normalized, await this.prepare(normalized), false);
  }

  remove(id: string) {
    const draft = this.get(id);
    const cancelled =
      !draft.signalId ||
      this.cancel([draft.signalId]).cancelledSignalIds.includes(draft.signalId);
    this.drafts.delete(id);
    this.changed();
    if (!cancelled) throw new ThreadError('QUEUED_MESSAGE_NOT_FOUND', 409);
  }

  clear() {
    const drafts = [...this.drafts.values()];
    const ids = drafts.flatMap((draft) =>
      draft.signalId ? [draft.signalId] : [],
    );
    const cancelled = new Set(
      ids.length ? this.cancel(ids).cancelledSignalIds : [],
    );
    for (const [id, draft] of this.drafts)
      if (!draft.signalId || cancelled.has(draft.signalId))
        this.drafts.delete(id);
    this.changed();
  }

  discard() {
    this.drafts.clear();
    this.changed();
  }

  async update(id: string, patch: UpdateQueuedMessage) {
    const original = this.get(id).input;
    const parsed = runInputSchema.safeParse({
      ...original,
      ...(patch.isImmediate === undefined
        ? {}
        : { isImmediate: patch.isImmediate }),
      ...(patch.text === undefined
        ? {}
        : {
            parts: [
              ...original.parts.filter((part) => part.type === 'file'),
              ...(patch.text.trim()
                ? [{ type: 'text', text: patch.text.trim() }]
                : []),
            ],
          }),
    });
    if (!parsed.success) throw new ThreadError('VALIDATION_ERROR', 400);
    const entries = [...this.drafts.values()];
    const start = entries.findIndex((draft) => draft.input.id === id);
    // Re-submit the affected suffix so an edit keeps its FIFO position.
    await this.replace([id], entries.slice(start), [
      parsed.data,
      ...entries.slice(start + 1).map((draft) => draft.input),
    ]);
  }

  async move(id: string, beforeId: string | null) {
    this.get(id);
    if (beforeId !== null) this.get(beforeId);
    if (id === beforeId) return;
    const entries = [...this.drafts.values()];
    const moved = entries.find((draft) => draft.input.id === id)!;
    const reordered = entries.filter((draft) => draft !== moved);
    reordered.splice(
      beforeId === null
        ? reordered.length
        : reordered.findIndex((draft) => draft.input.id === beforeId),
      0,
      moved,
    );
    const start = entries.findIndex(
      (draft, index) => draft !== reordered[index],
    );
    if (start < 0) return;
    await this.replace(
      beforeId === null ? [id] : [id, beforeId],
      entries.slice(start),
      reordered.slice(start).map((draft) => draft.input),
    );
  }

  private async replace(
    required: string[],
    originals: Draft[],
    desired: RunInput[],
  ) {
    // Resolve/validate every submission before cancelling any native input.
    const prepared = new Map(
      await Promise.all(
        desired.map(
          async (input) => [input.id, await this.prepare(input)] as const,
        ),
      ),
    );
    const ids = originals.flatMap((draft) =>
      draft.signalId ? [draft.signalId] : [],
    );
    const cancelled = new Set(
      ids.length ? this.cancel(ids).cancelledSignalIds : [],
    );
    const eligible = originals.filter(
      (draft) => !draft.signalId || cancelled.has(draft.signalId),
    );
    const canChange = required.every((id) =>
      eligible.some((draft) => draft.input.id === id),
    );
    const eligibleIds = new Set(eligible.map((draft) => draft.input.id));
    for (const draft of originals)
      if (this.drafts.get(draft.input.id) === draft)
        this.drafts.delete(draft.input.id);
    // A consumed target cannot be edited. Restore other successfully cancelled
    // inputs in their original order; never resubmit anything already running.
    const inputs = canChange
      ? desired.filter((input) => eligibleIds.has(input.id))
      : eligible.map((draft) => draft.input);
    const submissions = inputs.map((input) =>
      this.submit(input, prepared.get(input.id)!, true),
    );
    const results = await Promise.allSettled(submissions);
    this.changed();
    if (results.some((result) => result.status === 'rejected'))
      throw new ThreadError('QUEUE_UPDATE_FAILED', 502);
    if (!canChange) throw new ThreadError('QUEUED_MESSAGE_NOT_FOUND', 409);
  }
}
