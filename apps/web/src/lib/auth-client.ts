import { createAuthClient } from 'better-auth/react';
import { adminClient, usernameClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [usernameClient(), adminClient()],
});

export function isAdmin(role: string | null | undefined) {
  return (role ?? '').split(',').includes('admin');
}
