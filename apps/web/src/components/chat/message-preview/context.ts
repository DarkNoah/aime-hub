import { createContext, useContext } from 'react';
import type { PreviewPart } from './selection';

export const MessagePreviewContext = createContext<
  ((part: PreviewPart) => void) | null
>(null);

export function useMessagePreview() {
  return useContext(MessagePreviewContext);
}
