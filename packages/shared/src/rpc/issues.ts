import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure } from './base.js';
import {
  issueScopeSchema,
  issueListSchema,
  issueCreateSchema,
  issuePatchSchema,
  issueCommentSchema,
  issueMessageSchema,
  type Issue,
  type IssueList,
  type IssueDetail,
  type IssueComment,
} from '../issues.js';

const target = issueScopeSchema.extend({ id: z.number().int().positive() });
export const issuesContract = {
  forThread: procedure
    .input(issueScopeSchema.extend({ threadId: z.string() }))
    .output(type<Issue | null>()),
  list: procedure.input(issueListSchema).output(type<IssueList>()),
  view: procedure
    .input(target.extend({ cursor: z.string().optional() }))
    .output(type<IssueDetail>()),
  create: procedure
    .input(issueScopeSchema.extend({ data: issueCreateSchema }))
    .output(type<Issue>()),
  edit: procedure
    .input(target.extend({ data: issuePatchSchema }))
    .output(type<Issue>()),
  close: procedure.input(target).output(type<Issue>()),
  reopen: procedure.input(target).output(type<Issue>()),
  stop: procedure.input(target).output(type<Issue>()),
  comment: procedure
    .input(target.extend({ data: issueCommentSchema }))
    .output(type<IssueComment>()),
  message: procedure
    .input(target.extend({ data: issueMessageSchema }))
    .output(type<Issue>()),
};
