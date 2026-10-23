import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { ChatSettings } from '@aime/shared/threads';
import { useAuthSession } from '@/features/auth/session-context';
import { createChatPreferencesResource } from './preferences-resource';
import { PersonalChatSettingsContext } from './use-personal-chat-settings';
import { chatApi } from './api';

type Props = {
  children: ReactNode;
  initialSettings?: ChatSettings;
  projectId?: string;
  /** Plugin chats keep their agent/model selection on the thread. */
  threadId?: string;
};

export function PersonalChatSettingsProvider(props: Props) {
  const inherited = useContext(PersonalChatSettingsContext);
  const { data } = useAuthSession();
  if (inherited && !props.projectId && !props.threadId) return props.children;
  return (
    <SettingsSession
      key={`${data?.session.id}:${props.threadId ?? props.projectId ?? 'personal'}`}
      personal={inherited}
      {...props}
    />
  );
}

function SettingsSession({
  children,
  initialSettings,
  projectId,
  threadId,
  personal,
}: Props & {
  personal: ReturnType<typeof createChatPreferencesResource> | null;
}) {
  async function readPersonal() {
    if (!personal) return chatApi.preferences();
    await personal.load();
    return personal.getSnapshot().settings;
  }
  const [resource] = useState(() =>
    createChatPreferencesResource(
      initialSettings,
      threadId
        ? {
            read: async () => {
              const [{ thread }, personal] = await Promise.all([
                chatApi.get(threadId),
                readPersonal(),
              ]);
              return {
                agentId: thread.agentId ?? null,
                model: thread.model ?? personal.model,
                reasoningEffort: thread.reasoningEffort,
              };
            },
            save: async (settings) => {
              const thread = await chatApi.update(threadId, settings);
              return {
                agentId: thread.agentId ?? null,
                model: thread.model,
                reasoningEffort: thread.reasoningEffort,
              };
            },
          }
        : projectId
          ? {
              read: async () => {
                const [project, personal] = await Promise.all([
                  chatApi.projectPreferences(projectId),
                  readPersonal(),
                ]);
                return { ...project, agentId: personal.agentId ?? null };
              },
              // A member's current chat selection is local; shared defaults are edited in project settings.
              save: async (settings) => {
                const previous = await readPersonal();
                if ((previous.agentId ?? null) !== (settings.agentId ?? null))
                  await (personal ? personal.save : chatApi.savePreferences)({
                    ...previous,
                    agentId: settings.agentId ?? null,
                  });
                return settings;
              },
            }
          : undefined,
    ),
  );
  useEffect(() => {
    void resource.load();
    return () => resource.cancel();
  }, [resource]);
  return (
    <PersonalChatSettingsContext.Provider value={resource}>
      {children}
    </PersonalChatSettingsContext.Provider>
  );
}
