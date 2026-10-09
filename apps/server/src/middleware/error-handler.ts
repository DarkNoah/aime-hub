import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { ThreadError } from '../modules/threads/errors.js';
import { ProviderError } from '../modules/providers/network.js';
import { SkillError } from '../modules/skills/errors.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export const errorHandler: ErrorHandler = (error, c) => {
  if (
    error instanceof ThreadError ||
    error instanceof ProviderError ||
    error instanceof SkillError
  )
    return c.json({ code: error.code }, error.status as ContentfulStatusCode);
  if (error instanceof ZodError || error instanceof SyntaxError)
    return c.json({ code: 'VALIDATION_ERROR' }, 400);
  if (error instanceof HTTPException) return error.getResponse();
  console.error('请求处理失败', error.name);
  return c.json({ message: '服务暂时不可用，请稍后重试' }, 500);
};
