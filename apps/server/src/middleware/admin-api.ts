import type { RequestHandler, ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { ProviderError } from '../modules/providers/network.js';

export function adminApiPolicy(webOrigin: string): RequestHandler {
  const origin = new URL(webOrigin).origin;
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.get('origin') !== origin
    )
      return res.status(403).json({ code: 'FORBIDDEN' });
    next();
  };
}

export const adminApiErrorHandler: ErrorRequestHandler = (
  error,
  _req,
  res,
  next,
) => {
  if (error instanceof ProviderError)
    return res.status(error.status).json({ code: error.code });
  if (
    error instanceof ZodError ||
    (error instanceof SyntaxError && 'body' in error)
  )
    return res.status(400).json({ code: 'VALIDATION_ERROR' });
  if (
    error &&
    typeof error === 'object' &&
    'type' in error &&
    error.type === 'entity.too.large'
  )
    return res.status(413).json({ code: 'VALIDATION_ERROR' });
  next(error);
};
