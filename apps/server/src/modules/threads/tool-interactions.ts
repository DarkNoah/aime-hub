import { z } from 'zod';
import {
  userQuestionSchema,
  type ToolInteraction,
  type ToolResponse,
} from '@aime/shared/threads';
import { ThreadError } from './errors.js';

/** Validate before consuming a suspension so a malformed response remains retryable. */
export function validateToolResponse(
  interaction: ToolInteraction,
  response: ToolResponse,
) {
  if ((interaction.kind === 'suspended') !== (response.action === 'resume'))
    throw new ThreadError('VALIDATION_ERROR', 400);
  if (response.action !== 'resume') return;
  if (interaction.resumeSchema !== undefined) {
    try {
      const schema =
        typeof interaction.resumeSchema === 'string'
          ? JSON.parse(interaction.resumeSchema)
          : interaction.resumeSchema;
      if (
        typeof schema !== 'boolean' &&
        (!schema || typeof schema !== 'object' || Array.isArray(schema))
      )
        throw new Error('Invalid resume schema');
      z.fromJSONSchema(schema).parse(response.data);
    } catch {
      throw new ThreadError('VALIDATION_ERROR', 400);
    }
  }
  if (interaction.toolName === 'ask_user') {
    const question = userQuestionSchema.parse(interaction.suspendPayload);
    const values = Array.isArray(response.data)
      ? response.data
      : [response.data];
    if (
      (question.selectionMode === 'multi_select') !==
        Array.isArray(response.data) ||
      !values.length ||
      values.some((value) => typeof value !== 'string' || !value.trim())
    )
      throw new ThreadError('VALIDATION_ERROR', 400);
  }
}
