import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import type { Hono } from 'hono';
import type { HttpEnv } from './http.js';

export function createNodeServer(app: Hono<HttpEnv>) {
  return createServer(getRequestListener(app.fetch));
}
