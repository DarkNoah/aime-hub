import { useContext, useEffect } from 'react';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import { RoomUnreadContext } from '../unread-context';

/** Reading history or leaving this tab in the background does not consume new replies. */
export function RoomReadMarker({
  roomId,
  sequence,
}: {
  roomId: string;
  sequence?: string;
}) {
  const resource = useContext(RoomUnreadContext);
  const { isAtBottom } = useStickToBottomContext();
  useEffect(() => {
    if (!resource || !sequence || !isAtBottom) return;
    const mark = () => {
      if (document.visibilityState === 'visible' && document.hasFocus())
        void resource.markRead(roomId, sequence);
    };
    mark();
    const timer = setInterval(mark, 2500);
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [resource, roomId, sequence, isAtBottom]);
  return null;
}
