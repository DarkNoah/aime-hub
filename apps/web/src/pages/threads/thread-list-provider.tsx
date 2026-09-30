import { useEffect, useState, type ReactNode } from 'react';
import { createThreadListResource } from './list-resource';
import { ThreadListContext } from './use-thread-list';

export function ThreadListProvider({ children }: { children: ReactNode }) {
  const [resource] = useState(createThreadListResource);
  useEffect(() => {
    void resource.loadMore();
    return () => resource.cancel();
  }, [resource]);
  return (
    <ThreadListContext.Provider value={resource}>
      {children}
    </ThreadListContext.Provider>
  );
}
