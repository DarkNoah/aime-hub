import { oc } from '@orpc/contract';
import { z } from 'zod';

export const procedure = oc;
export const id = z.string().min(1).max(128);
export const threadId = z.string().regex(/^[a-zA-Z0-9_-]{16}$/);
export const page = z.coerce.number().int().min(0).max(10000).default(0);
export const perPage = z.coerce.number().int().min(1).max(50);
