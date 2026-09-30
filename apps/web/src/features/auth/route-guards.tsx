import { Navigate, Outlet } from 'react-router';
import { useAuthSession } from '@/features/auth/session-context';
import { isAdmin } from '@/features/auth/client';

export function RequireSession() {
  const { data } = useAuthSession();
  return data ? <Outlet /> : <Navigate to="/login" replace />;
}

export function PublicOnly() {
  const { data } = useAuthSession();
  return data ? <Navigate to="/" replace /> : <Outlet />;
}

export function RequireAdmin() {
  const { data } = useAuthSession();
  if (!data) return <Navigate to="/login" replace />;
  return isAdmin(data.user.role) ? <Outlet /> : <Navigate to="/" replace />;
}
