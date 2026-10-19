import { rpc, required } from '../../rpc/context.js';
import type { ThreadService } from '../threads/service.js';
import {
  listWorkspaceFiles,
  mutateWorkspaceFile,
  previewWorkspaceFile,
  searchWorkspaceFiles,
} from './workspace-files.js';
import { fileError } from './paths.js';
import { saveWorkspaceFile } from './save.js';

export function fileRouter(service?: ThreadService) {
  const p = rpc.files.use(async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      fileError(error);
    }
  });
  return p.router({
    save: p.save.handler(({ context, input }) =>
      required(service).withWorkspaceFiles(
        context.userId,
        input.params.threadId,
        (root) => saveWorkspaceFile(root, input.body),
        input.query.scope,
      ),
    ),
    resolve: p.resolve.handler(({ context, input }) =>
      required(service).resolveWorkspaceFile(
        context.userId,
        input.params.threadId,
        input.query.path,
      ),
    ),
    list: p.list.handler(({ context, input }) =>
      required(service).withWorkspaceFiles(
        context.userId,
        input.params.threadId,
        (root) => listWorkspaceFiles(root, input.query.path),
        input.query.scope,
      ),
    ),
    preview: p.preview.handler(({ context, input }) =>
      required(service).withWorkspaceFiles(
        context.userId,
        input.params.threadId,
        (root) => previewWorkspaceFile(root, input.query.path),
        input.query.scope,
      ),
    ),
    search: p.search.handler(({ context, input, signal }) =>
      required(service).withWorkspaceFiles(
        context.userId,
        input.params.threadId,
        (root) => searchWorkspaceFiles(root, input.query.query, signal),
        input.query.scope,
      ),
    ),
    mutate: p.mutate.handler(({ context, input }) =>
      required(service).withWorkspaceFiles(
        context.userId,
        input.params.threadId,
        (root) => mutateWorkspaceFile(root, input.body),
        input.query?.scope,
      ),
    ),
  });
}
