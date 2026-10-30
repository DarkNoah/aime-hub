import { useEffect, useRef } from 'react';
import type { GroupChatMessage } from '@aime/shared/group-chats';
import { playReactionFeedback } from '@/components/reactions/reaction-feedback';

/** Compare memberships, not counts: simultaneous add/remove can keep the same count. */
export function useReactionFeedback(reactions: GroupChatMessage['reactions']) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef(reactions);
  const playing = useRef(new Map<string, () => void>());

  useEffect(() => {
    const before = new Map(
      previous.current?.map(({ emoji, memberIds }) => [emoji, memberIds]),
    );
    previous.current = reactions;
    let bursts = 0;
    for (const { emoji, memberIds } of reactions ?? []) {
      const old = before.get(emoji) ?? [];
      const added = memberIds.some((id) => !old.includes(id));
      const removed = old.some((id) => !memberIds.includes(id));
      if (!added && !removed) continue;
      const anchor = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          '[data-reaction-emoji]',
        ) ?? []),
      ].find((element) => element.dataset.reactionEmoji === emoji);
      if (!anchor || ++bursts > 3) continue;
      playing.current.get(emoji)?.();
      playing.current.set(emoji, playReactionFeedback(anchor, emoji, added));
    }
    for (const emoji of playing.current.keys()) {
      if (reactions?.some((reaction) => reaction.emoji === emoji)) continue;
      playing.current.get(emoji)?.();
      playing.current.delete(emoji);
    }
  }, [reactions]);

  useEffect(() => {
    const effects = playing.current;
    return () => {
      for (const stop of effects.values()) stop();
      effects.clear();
    };
  }, []);

  return ref;
}
