import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { INDICATOR_STORAGE_KEY, readPreferences } from './preferences';
import type { IndicatorParameters } from './types';

export function useIndicators() {
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        INDICATOR_STORAGE_KEY,
        JSON.stringify(preferences),
      );
    } catch {
      toast.error('浏览器未能保存指标设置，本次修改仅在当前页面生效', {
        id: 'indicator-storage-error',
      });
    }
  }, [preferences]);

  function setVisible(id: string, visible: boolean) {
    setPreferences((current) => ({
      ...current,
      [id]: { ...current[id], visible },
    }));
  }
  function setParameters(id: string, parameters: IndicatorParameters) {
    setPreferences((current) => ({
      ...current,
      [id]: { ...current[id], parameters },
    }));
  }
  return { preferences, setVisible, setParameters };
}
