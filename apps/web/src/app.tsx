import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { AvailableModelsProvider } from '@/features/models/available-models-provider';
import { SessionProvider } from '@/features/auth/session-provider';
import {
  PublicOnly,
  RequireAdmin,
  RequireSession,
} from '@/features/auth/route-guards';
import { AppLayout } from '@/layouts/app-layout';
import { LoadingState } from '@/components/loading-state';

const AuthPage = lazy(() =>
  import('@/pages/auth/page').then((m) => ({ default: m.AuthPage })),
);
const WorkspacePage = lazy(() =>
  import('@/pages/workspace/page').then((m) => ({ default: m.WorkspacePage })),
);
const ThreadsPage = lazy(() =>
  import('@/pages/threads/page').then((m) => ({ default: m.ThreadsPage })),
);
const AdminOverviewPage = lazy(() =>
  import('@/pages/admin/overview/page').then((m) => ({
    default: m.AdminOverviewPage,
  })),
);
const AdminSettingsPage = lazy(() =>
  import('@/pages/admin/settings/page').then((m) => ({
    default: m.AdminSettingsPage,
  })),
);
const AdminUsersPage = lazy(() =>
  import('@/pages/admin/users/page').then((m) => ({
    default: m.AdminUsersPage,
  })),
);
const AdminProvidersPage = lazy(() =>
  import('@/pages/admin/providers/page').then((m) => ({
    default: m.AdminProvidersPage,
  })),
);
const NotFoundPage = lazy(() =>
  import('@/pages/errors/not-found-page').then((m) => ({
    default: m.NotFoundPage,
  })),
);

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <AvailableModelsProvider>
          <Suspense
            fallback={<LoadingState className="mx-auto mt-20 max-w-xl" />}
          >
            <Routes>
              <Route element={<PublicOnly />}>
                <Route
                  path="/login"
                  element={<AuthPage key="login" mode="login" />}
                />
                <Route
                  path="/register"
                  element={<AuthPage key="register" mode="register" />}
                />
              </Route>
              <Route element={<RequireSession />}>
                <Route element={<AppLayout />}>
                  <Route index element={<WorkspacePage />} />
                  <Route path="/threads" element={<ThreadsPage />} />
                  <Route path="/threads/:threadId" element={<ThreadsPage />} />
                  <Route element={<RequireAdmin />}>
                    <Route path="/admin" element={<AdminOverviewPage />} />
                    <Route
                      path="/admin/providers"
                      element={<AdminProvidersPage />}
                    />
                    <Route path="/admin/users" element={<AdminUsersPage />} />
                    <Route
                      path="/admin/settings"
                      element={<AdminSettingsPage />}
                    />
                  </Route>
                </Route>
              </Route>
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </AvailableModelsProvider>
      </SessionProvider>
    </BrowserRouter>
  );
}
