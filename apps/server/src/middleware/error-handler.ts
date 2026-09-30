import type { ErrorRequestHandler } from 'express';

export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  console.error(
    '请求处理失败',
    error instanceof Error ? error.name : 'UnknownError',
  );
  res.status(500).json({ message: '服务暂时不可用，请稍后重试' });
};
