import { z } from 'zod';
import { knowledgeFieldSchema } from '@aime/shared/knowledge';

// Model-facing structures only. KnowledgeService validates names, values and permissions.
export const knowledgeToolTags = z.record(z.string(), z.array(z.string()));
export const knowledgeToolFieldType = knowledgeFieldSchema.shape.type;
