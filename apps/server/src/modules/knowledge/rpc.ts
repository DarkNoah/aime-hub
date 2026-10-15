import { rpc, required } from '../../rpc/context.js';
import type { KnowledgeService } from './service.js';

export function knowledgeRouter(service?: KnowledgeService) {
  const p = rpc.knowledge;
  const kb = () => required(service);
  return p.router({
    sharing: p.sharing.handler(({ context, input }) =>
      kb().sharing(context.userId, input.id),
    ),
    setSharing: p.setSharing.handler(({ context, input }) =>
      kb().setSharing(context.userId, input.id, input.sharing),
    ),
    members: p.members.handler(({ context, input }) =>
      kb().members(context.userId, input.id, input),
    ),
    setMember: p.setMember.handler(({ context, input }) =>
      kb().setMember(context.userId, input.id, input.member),
    ),
    removeMember: p.removeMember.handler(({ context, input }) =>
      kb().removeMember(context.userId, input.id, input.userId),
    ),
    searchUsers: p.searchUsers.handler(({ context, input }) =>
      kb().searchUsers(context.userId, input.id, input.query, input.cursor),
    ),
    createVersion: p.createVersion.handler(({ context, input }) =>
      kb().createVersion(context.userId, input.id, input.data),
    ),
    versions: p.versions.handler(({ context, input }) =>
      kb().versions(context.userId, input.id, input.before),
    ),
    version: p.version.handler(({ context, input }) =>
      kb().version(context.userId, input.id, input.version),
    ),
    versionFile: p.versionFile.handler(({ context, input }) =>
      kb().versionFile(context.userId, input.id, input.version),
    ),
    tags: p.tags.handler(({ context, input }) =>
      kb().tags(context.userId, input.id),
    ),
    restoreDocument: p.restoreDocument.handler(({ context, input }) =>
      kb().restoreDocument(context.userId, input.id),
    ),
    updateDocument: p.updateDocument.handler(({ context, input }) =>
      kb().updateDocument(context.userId, input.id, input.data),
    ),
    modelDefaults: p.modelDefaults.handler(() => kb().modelDefaults()),
    get: p.get.handler(({ context, input }) =>
      kb().get(context.userId, input.id),
    ),
    list: p.list.handler(({ context, input }) =>
      kb().list(context.userId, input),
    ),
    create: p.create.handler(({ context, input }) =>
      kb().create(context.userId, input.scope, input.data),
    ),
    update: p.update.handler(({ context, input }) =>
      kb().update(context.userId, input.id, input.data),
    ),
    remove: p.remove.handler(({ context, input }) =>
      kb().remove(context.userId, input.id),
    ),
    documents: p.documents.handler(({ context, input }) =>
      kb().documents(
        context.userId,
        input.id,
        input.cursor,
        input.tags,
        input.archived,
        input.metadata,
      ),
    ),
    statuses: p.statuses.handler(({ context, input }) =>
      kb().statuses(context.userId, input.id, input.ids),
    ),
    import: p.import.handler(({ context, input }) =>
      kb().import(
        context.userId,
        input.id,
        input.source,
        undefined,
        undefined,
        input.tags,
        input.metadata,
      ),
    ),
    document: p.document.handler(({ context, input }) =>
      kb().document(context.userId, input.id),
    ),
    retry: p.retry.handler(({ context, input }) =>
      kb().retry(context.userId, input.id),
    ),
    setDocumentEnabled: p.setDocumentEnabled.handler(({ context, input }) =>
      kb().setDocumentEnabled(context.userId, input.id, input.enabled),
    ),
    removeDocument: p.removeDocument.handler(({ context, input }) =>
      kb().removeDocument(context.userId, input.id),
    ),
    search: p.search.handler(({ context, input }) =>
      kb().search(
        context.userId,
        input.id,
        input.query,
        input.topK,
        input.tags,
        input.metadata,
        input.where,
      ),
    ),
  });
}
