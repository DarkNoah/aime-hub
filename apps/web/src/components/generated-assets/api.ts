import type { AssetQuery } from '@aime/shared/assets';
import { api } from '@/lib/rpc';

export const assetsApi = {
  list: (threadId: string, query: Partial<AssetQuery>, signal?: AbortSignal) =>
    api.assets.list({ params: { threadId }, query }, { signal }),
  attach: (threadId: string, ids: string[]) =>
    api.assets.attach({ params: { threadId }, body: { ids } }),
};
