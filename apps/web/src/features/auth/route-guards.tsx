import {
  Navigate,
  Outlet,
  useLocation,
  useSearch,
} from '@tanstack/react-router';
import { useAuthSession } from '@/features/auth/session-context';
import { isAdmin } from '@/features/auth/client';

export function RequireSession() {
  const { data } = useAuthSession();
  const location = useLocation();
  if (data) return <Outlet />;
  // The destination can already be current while the protected layout unmounts.
  if (location.pathname === '/login') return null;
  const returnTo =
    location.pathname === '/vibe-quant' ? location.href : undefined;
  return <Navigate to="/login" search={{ returnTo }} replace />;
}

export function PublicOnly() {
  const { data } = useAuthSession();
  const returnTo = useSearch({
    from: '/application/public',
    select: (search) => search.returnTo,
  });
  return data ? (
    <Navigate to={returnTo ? '/vibe-quant' : '/'} href={returnTo} replace />
  ) : (
    <Outlet />
  );
}

export function RequireAdmin() {
  const { data } = useAuthSession();
  if (!data) return <Navigate to="/login" replace />;
  return isAdmin(data.user.role) ? <Outlet /> : <Navigate to="/" replace />;
}
