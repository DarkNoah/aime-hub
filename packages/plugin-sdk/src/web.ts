import type { ComponentType } from 'react';
import type { PluginStatus, PluginConfigIssue } from './index.js';

export class PluginRequestError extends Error {
  constructor(
    code: string,
    public readonly plugin?: PluginStatus,
    public readonly issues?: PluginConfigIssue[],
  ) {
    super(code);
    this.name = 'PluginRequestError';
  }
}

export interface PluginPageProps {
  pluginId: string;
  path: string;
  params: Readonly<Record<string, string>>;
}
export interface PluginSidebarProps {
  pluginId: string;
  sidebarId: string;
  /** Undefined for a chat that has not been created yet. Not an authorization token. */
  threadId?: string;
  /** Undefined outside project chats. Not an authorization token. */
  projectId?: string;
  onClose(): void;
}
export interface PluginWeb {
  /** Keys must exactly match manifest.pages[].path. */
  pages: Record<string, ComponentType<PluginPageProps>>;
  /** Keys must exactly match manifest.rightSidebar[].id. Loaded on first open. */
  rightSidebar?: Record<string, ComponentType<PluginSidebarProps>>;
}

/** Same-origin session request. Paths are relative to this plugin's API root. */
export async function pluginRequest<T>(
  pluginId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (
    !/^[a-z][a-z0-9-]{0,39}$/.test(pluginId) ||
    !path.startsWith('/') ||
    path.includes('..')
  )
    throw new Error('Invalid plugin API path');
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/plugins/${pluginId}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers,
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      code?: string;
      plugin?: PluginStatus;
      issues?: PluginConfigIssue[];
    };
    throw new PluginRequestError(
      error.code ?? `HTTP ${response.status}`,
      error.plugin,
      error.issues,
    );
  }
  return response.json() as Promise<T>;
}
