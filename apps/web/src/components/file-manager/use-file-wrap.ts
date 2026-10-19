import { useSyncExternalStore } from 'react';

const key = 'workspace-file-word-wrap';
const event = 'workspace-file-word-wrap-change';
let fallback = false;
function snapshot() {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return fallback;
  }
}
function subscribe(callback: () => void) {
  window.addEventListener('storage', callback);
  window.addEventListener(event, callback);
  return () => {
    window.removeEventListener('storage', callback);
    window.removeEventListener(event, callback);
  };
}
export function useFileWrap() {
  const wrap = useSyncExternalStore(subscribe, snapshot, () => false);
  return [
    wrap,
    (value: boolean) => {
      fallback = value;
      try {
        localStorage.setItem(key, String(value));
      } catch {
        /* Storage can be disabled. */
      }
      window.dispatchEvent(new Event(event));
    },
  ] as const;
}
