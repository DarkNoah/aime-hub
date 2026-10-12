import { randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import { hasAdminRole } from '@aime/shared';
import type {
  Automation,
  AutomationInput,
  AutomationScope,
  AutomationRun,
} from '@aime/shared/automations';
import type { Mastra } from '@mastra/core/mastra';
import type { AnySchedule } from '@mastra/core/schedules';
import { computeNextFireAt } from '@mastra/core/workflows';
import { ThreadError } from '../threads/errors.js';
import type { ProjectService } from '../projects/service.js';
import {
  automationAgentId,
  automationResource,
  legacyMetadataSchema,
  legacyWorkflowId,
  metadataSchema,
  systemTimezone,
  type AutomationMetadata,
} from './metadata.js';

export type { AutomationMetadata } from './metadata.js';
export interface AutomationAccess {
  user(
    id: string,
  ): Promise<{ role?: string | null; banned?: boolean | null } | null>;
}
export interface AutomationThreads {
  create(task: Automation): Promise<void>;
  update(task: Automation): Promise<void>;
  assert(task: Automation): Promise<void>;
}
export type AutomationResult = Pick<AutomationRun, 'status' | 'text' | 'error'>;
export const runStateType = (runId: string) => `automation-run:${runId}`;

export class AutomationService {
  private mutations = new Map<string, Promise<unknown>>();
  constructor(
    private mastra: Mastra,
    private projects: Pick<ProjectService, 'assertMember'>,
    private access: AutomationAccess,
    private validateSettings: (
      meta: Pick<AutomationMetadata, 'ownerId' | 'scope' | 'data'>,
    ) => Promise<void>,
    private threads: AutomationThreads,
  ) {}

  private locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(action)
      .finally(() => {
        if (this.mutations.get(id) === next) this.mutations.delete(id);
      });
    this.mutations.set(id, next);
    return next;
  }

  private async permission(
    userId: string,
    scope: AutomationScope,
    write = false,
  ) {
    const user = await this.access.user(userId);
    if (!user || user.banned) throw new ThreadError('FORBIDDEN', 403);
    if (scope.scope === 'system' && !hasAdminRole(user.role))
      throw new ThreadError('FORBIDDEN', 403);
    const canManage =
      scope.scope !== 'project' ||
      (await this.projects.assertMember(userId, scope.projectId)).role !==
        'member';
    if (write && !canManage) throw new ThreadError('FORBIDDEN', 403);
    return canManage;
  }

  private metadata(row: AnySchedule | null) {
    const parsed = metadataSchema.safeParse(row?.metadata);
    if (
      !row ||
      row.agentId !== automationAgentId ||
      !parsed.success ||
      row.threadId !== parsed.data.threadId ||
      row.resourceId !== parsed.data.resourceId ||
      row.resourceId !==
        automationResource(parsed.data.scope, parsed.data.ownerId)
    )
      throw new ThreadError('AUTOMATION_NOT_FOUND', 404);
    return parsed.data;
  }

  private view(row: AnySchedule): Automation {
    const meta = this.metadata(row);
    return {
      ...meta.data,
      enabled: row.status === 'active',
      cron: row.cron,
      timezone: row.timezone ?? systemTimezone(),
      id: row.id,
      threadId: meta.threadId,
      threadCreated: meta.threadCreated,
      resourceId: meta.resourceId,
      scope: meta.scope,
      createdBy: meta.ownerId,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
      nextFireAt:
        row.status === 'active' ? new Date(row.nextFireAt).toISOString() : null,
      lastFireAt: row.lastFireAt
        ? new Date(row.lastFireAt).toISOString()
        : null,
    };
  }

  private async authorized(userId: string, id: string, write = false) {
    const row = await this.mastra.schedules.get(id);
    const meta = this.metadata(row);
    if (meta.scope.scope === 'personal' && meta.ownerId !== userId)
      throw new ThreadError('AUTOMATION_NOT_FOUND', 404);
    await this.permission(userId, meta.scope, write);
    return { row: row!, meta };
  }

  async notificationTask(id: string) {
    const row = await this.mastra.schedules.get(id);
    return this.view(row!);
  }

  async list(userId: string, scope: AutomationScope) {
    const canManage = await this.permission(userId, scope);
    const rows = await this.mastra.schedules.list({
      agentId: automationAgentId,
      resourceId: automationResource(scope, userId),
    });
    return {
      items: rows
        .filter((row) => row.metadata?.managedBy === 'automations')
        .map((row) => this.view(row))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      canManage,
    };
  }

  private async validate(
    meta: Pick<AutomationMetadata, 'ownerId' | 'scope' | 'data'>,
  ) {
    try {
      computeNextFireAt(meta.data.cron, { timezone: systemTimezone() });
    } catch {
      throw new ThreadError('AUTOMATION_CRON_INVALID');
    }
    await this.validateSettings(meta);
  }

  private target(meta: AutomationMetadata, id: string) {
    return {
      agentId: automationAgentId,
      prompt: meta.data.prompt,
      name: meta.data.name,
      threadId: meta.threadId,
      resourceId: meta.resourceId,
      signalType: 'user' as const,
      ifActive: { behavior: 'discard' as const },
      ifIdle: {
        behavior: 'wake' as const,
        streamOptions: { requestContext: { automationId: id } },
      },
    };
  }

  async create(userId: string, scope: AutomationScope, data: AutomationInput) {
    await this.permission(userId, scope, true);
    const draft = { ownerId: userId, scope, data };
    await this.validate(draft);
    const id = `agent_${randomUUID()}`;
    // Native targets are immutable; reserve the ID without creating a conversation.
    const meta: AutomationMetadata = {
      managedBy: 'automations',
      version: 2,
      ...draft,
      threadId: `schedule:${nanoid(16)}`,
      resourceId: automationResource(scope, userId),
      threadCreated: false,
    };
    return this.view(
      await this.mastra.schedules.create({
        id,
        ...this.target(meta, id),
        cron: data.cron,
        timezone: systemTimezone(),
        status: data.enabled ? 'active' : 'paused',
        metadata: meta,
      }),
    );
  }

  async update(userId: string, id: string, data: AutomationInput) {
    return this.locked(id, async () => {
      const { meta } = await this.authorized(userId, id, true);
      const next = { ...meta, data };
      await this.validate(next);
      await this.threads.assert(
        this.view((await this.mastra.schedules.get(id))!),
      );
      const row = await this.mastra.schedules.update(id, {
        cron: data.cron,
        timezone: systemTimezone(),
        prompt: data.prompt,
        name: data.name,
        status: data.enabled ? 'active' : 'paused',
        metadata: next,
      });
      const task = this.view(row);
      await this.threads.update(task);
      return task;
    });
  }

  async setEnabled(userId: string, id: string, enabled: boolean) {
    const { row, meta } = await this.authorized(userId, id, true);
    if (enabled) {
      await this.validate(meta);
      await this.threads.assert(this.view(row));
    }
    return this.view(
      await (enabled
        ? this.mastra.schedules.resume(id)
        : this.mastra.schedules.pause(id)),
    );
  }

  async remove(userId: string, id: string) {
    return this.locked(id, async () => {
      await this.authorized(userId, id, true);
      // Keep the conversation and its messages after removing the schedule.
      await this.mastra.schedules.delete(id);
    });
  }

  async run(userId: string, id: string) {
    const { meta } = await this.authorized(userId, id, true);
    await this.validate(meta);
    const task = await this.prepare(id);
    await this.mastra.schedules.run(id);
    return task;
  }

  async prepare(id: string) {
    return this.locked(id, () => this.prepareThread(id));
  }

  private async prepareThread(id: string) {
    const row = await this.mastra.schedules.get(id);
    const meta = this.metadata(row);
    await this.permission(meta.ownerId, meta.scope, true);
    let task = this.view(row!);
    await this.threads.assert(task);
    if (!meta.threadCreated) {
      await this.validateSettings(meta);
      await this.threads.create(task);
      // Re-read to preserve edits made while the first workspace was being created.
      const current = this.metadata(await this.mastra.schedules.get(id));
      await this.threads.update({ ...task, threadCreated: true });
      task = this.view(
        await this.mastra.schedules.update(id, {
          metadata: { ...current, threadCreated: true },
        }),
      );
    }
    return task;
  }

  /** Upgrade the previous workflow implementation in place, preserving IDs and history. */
  async initialize() {
    const storage = (await this.mastra.getStorage()!.getStore('schedules'))!;
    for (const row of await storage.listSchedules()) {
      if (row.metadata?.managedBy !== 'automations') continue;
      const legacy = legacyMetadataSchema.safeParse(row.metadata);
      if (
        row.target.type === 'workflow' &&
        row.target.workflowId === legacyWorkflowId &&
        legacy.success
      ) {
        const { timezone: _timezone, ...data } = legacy.data.data;
        void _timezone;
        const draft = { ...legacy.data, data };
        const meta: AutomationMetadata = {
          ...draft,
          threadId: `schedule:${nanoid(16)}`,
          resourceId: automationResource(draft.scope, draft.ownerId),
          threadCreated: false,
          version: 2,
        };
        await storage.updateSchedule(row.id, {
          target: { type: 'agent', ...this.target(meta, row.id) },
          metadata: meta,
          ownerType: 'agent',
          ownerId: automationAgentId,
          timezone: systemTimezone(),
          nextFireAt: computeNextFireAt(row.cron, {
            timezone: systemTimezone(),
          }),
        });
      } else if (
        metadataSchema.safeParse(row.metadata).success &&
        row.timezone !== systemTimezone()
      ) {
        await this.mastra.schedules.update(row.id, {
          timezone: systemTimezone(),
        });
      }
    }
  }

  async history(userId: string, id: string): Promise<AutomationRun[]> {
    const { meta } = await this.authorized(userId, id);
    const storage = this.mastra.getStorage()!;
    const [schedules, states, workflows] = await Promise.all([
      storage.getStore('schedules'),
      storage.getStore('threadState'),
      storage.getStore('workflows'),
    ]);
    const triggers = await schedules!.listTriggers(id, { limit: 30 });
    return Promise.all(
      triggers.map(async (trigger): Promise<AutomationRun> => {
        const state = trigger.runId
          ? await states!.getState<AutomationResult>({
              threadId: meta.threadId,
              type: runStateType(trigger.runId),
            })
          : undefined;
        // Old workflow snapshots remain readable after the one-time upgrade.
        const snapshot =
          !state && trigger.outcome === 'published' && trigger.runId
            ? await workflows!.loadWorkflowSnapshot({
                workflowName: legacyWorkflowId,
                runId: trigger.runId,
              })
            : null;
        const step = snapshot?.context?.['execute-automation'];
        const result =
          state ??
          (step?.status === 'success'
            ? (step.output as AutomationResult)
            : undefined);
        const skipped = [
          'skipped',
          'discarded',
          'persisted',
          'delivered',
        ].includes(trigger.outcome);
        const failed =
          trigger.outcome === 'failed' ||
          trigger.outcome === 'aborted' ||
          snapshot?.status === 'failed';
        return {
          id: trigger.id ?? trigger.runId ?? `${trigger.actualFireAt}`,
          firedAt: new Date(trigger.actualFireAt).toISOString(),
          status:
            result?.status ??
            (skipped ? 'skipped' : failed ? 'failed' : 'running'),
          text: result?.text ?? '',
          error:
            result?.error ??
            (failed
              ? 'AUTOMATION_RUN_FAILED'
              : skipped
                ? 'AUTOMATION_ALREADY_RUNNING'
                : null),
        };
      }),
    );
  }
}
