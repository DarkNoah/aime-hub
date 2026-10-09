import { Hono } from 'hono';

export function healthRoutes() {
  return new Hono().get('/health', (c) => c.json({ status: 'ok' }));
}
