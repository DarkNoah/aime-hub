import { useEffect, useState } from 'react';
import { toast } from 'sonner';

const STORAGE_KEY = 'vibe-quant:hidden-strategy-risk:v1';

function readHiddenStrategies(): Set<string> {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '[]',
    );
    return new Set(
      Array.isArray(value)
        ? value.filter((id): id is string => typeof id === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

/** Display preferences stay separate from monitor execution and polling. */
export function useStrategyVisibility() {
  const [hiddenStrategyIds, setHiddenStrategyIds] =
    useState(readHiddenStrategies);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([...hiddenStrategyIds]),
      );
    } catch {
      toast.error('浏览器未能保存策略显示设置，本次修改仅在当前页面生效', {
        id: 'strategy-visibility-storage-error',
      });
    }
  }, [hiddenStrategyIds]);

  function setVisible(id: string, visible: boolean) {
    setHiddenStrategyIds((current) => {
      if (current.has(id) === !visible) return current;
      const next = new Set(current);
      if (visible) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return { hiddenStrategyIds, setVisible };
}
