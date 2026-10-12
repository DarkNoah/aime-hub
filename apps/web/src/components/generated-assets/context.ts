import { createContext, useContext } from 'react';
import type { GeneratedAsset } from '@aime/shared/assets';

export type Receiver = (assets: GeneratedAsset[]) => boolean;
export const AssetAttachmentContext = createContext<{
  add: Receiver;
  register: (receiver: Receiver) => () => void;
} | null>(null);
export function useAssetAttachments() {
  return useContext(AssetAttachmentContext);
}
