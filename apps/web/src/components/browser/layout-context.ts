import { createContext } from 'react';
import type { BrowserSummary } from '@aime/shared/browser';

export const BrowserPanelOpenContext = createContext<(() => void) | null>(null);
export const RunningBrowsersContext = createContext<readonly BrowserSummary[]>(
  [],
);
