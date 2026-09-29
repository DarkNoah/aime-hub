import { createContext, useContext } from 'react';
import { authClient } from './auth-client';

type SessionState = ReturnType<typeof authClient.useSession>;
export const SessionContext = createContext<SessionState | null>(null);

export function useAuthSession() {
  const session = useContext(SessionContext);
  if (!session)
    throw new Error('useAuthSession must be used within SessionProvider');
  return session;
}
