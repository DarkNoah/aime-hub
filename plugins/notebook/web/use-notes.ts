import { useEffect, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';

export type Note = {
  id: string;
  title: string;
  content: string;
  slug: string;
  createdAt: string;
};

export function useNotes(pluginId: string) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void pluginRequest<Note[]>(pluginId, '/notes', {
      signal: controller.signal,
    }).then(
      (value) => {
        if (!controller.signal.aborted) {
          setNotes(value);
          setLoading(false);
          setError(false);
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setError(true);
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [pluginId, revision]);
  return {
    notes,
    setNotes,
    loading,
    error,
    reload: () => setRevision((value) => value + 1),
  };
}
