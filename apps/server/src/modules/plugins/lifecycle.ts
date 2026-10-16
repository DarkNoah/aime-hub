import type { PluginServer } from '@app/plugin-sdk/server';
import type { PluginConfig } from '@app/plugin-sdk';

/** Per-process resources. The service serializes calls and supplies persisted revisions. */
export class PluginLifecycle {
  private active = new Map<string, string>();
  private dirty = new Map<string, PluginConfig>();
  private failures = new Map<string, string>();

  constructor(private readonly servers: ReadonlyMap<string, PluginServer>) {}

  isEnabled(id: string, revision: string) {
    return this.active.get(id) === revision;
  }

  reason(id: string) {
    return this.failures.get(id);
  }

  setRevision(id: string, revision: string) {
    if (this.active.has(id)) this.active.set(id, revision);
  }

  async enable(id: string, revision: string, config: PluginConfig = {}) {
    if (this.isEnabled(id, revision)) return;
    // A failed cleanup must succeed before another activation can allocate resources.
    await this.disable(id);
    const snapshot = Object.freeze(structuredClone(config));
    this.dirty.set(id, snapshot);
    try {
      await this.servers.get(id)?.onEnable?.({ config: snapshot });
      this.active.set(id, revision);
      this.failures.delete(id);
    } catch (error) {
      this.failures.set(id, '插件启动失败，等待重试');
      try {
        await this.disable(id);
        this.failures.set(id, '插件启动失败，等待重试');
      } catch {
        // disable preserves the cleanup failure and dirty marker for the next attempt.
      }
      throw error;
    }
  }

  async disable(id: string) {
    this.active.delete(id);
    if (!this.dirty.has(id)) {
      this.failures.delete(id);
      return;
    }
    try {
      await this.servers.get(id)?.onDisable?.({ config: this.dirty.get(id)! });
      this.dirty.delete(id);
      this.failures.delete(id);
    } catch (error) {
      this.failures.set(id, '插件已停止提供服务，但资源清理失败，等待重试');
      throw error;
    }
  }

  async dispose() {
    const errors: unknown[] = [];
    // Dependents must finish all cleanup before their dependencies are destroyed.
    for (const [id, server] of [...this.servers].reverse()) {
      try {
        await this.disable(id);
      } catch (error) {
        errors.push(error);
      }
      try {
        await server.dispose?.();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'Plugin cleanup failed');
  }
}
