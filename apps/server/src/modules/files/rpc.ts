import { rpc, required } from '../../rpc/context.js';
import type { ThreadService } from '../threads/service.js';
import {
  listWorkspaceFiles,
  mutateWorkspaceFile,
  previewWorkspaceFile,
  searchWorkspaceFiles,
} from './workspace-files.js';
import { fileError } from './paths.js';

export function fileRouter(service?: ThreadService) {
  const p = rpc.files.use(async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      fileError(error);
    }
  });
  return p.router({
    list: p.list.handler(({ context, input }) =>
      required(service).withWorkspaceFiles(
        context.userId,
        input.params.threadId,
        (root) => listWorkspaceFiles(root, input.query.path),
      ),
    ),
    preview: p.preview.handler(({ context, input }) =>
      required(service).withWorkspaceFiles(
        context.userId,
        input.params.threadId,
        (root) => previewWorkspaceFile(root, input.query.path),
      ),
    ),
    search: p.search.handler(({ context, input, signal }) =>
      required(service).withWorkspaceFiles(
        context.userId,
        input.params.threadId,
        (root) => searchWorkspaceFiles(root, input.query.query, signal),
      ),
    ),
    mutate: p.mutate.handler(({ context, input }) =>
      required(service).withWorkspaceFiles(
        context.userId,
        input.params.threadId,
        (root) => mutateWorkspaceFile(root, input.body),
      ),
    ),
  });
}
