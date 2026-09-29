import { useTranslation } from 'react-i18next';
import { LayoutDashboard, Settings2 } from 'lucide-react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { SessionProvider } from '@/components/auth/session-provider';
import {
  PublicOnly,
  RequireAdmin,
  RequireSession,
} from '@/components/auth/route-guards';
import { AppLayout } from '@/components/app-layout';
import { AuthPage } from '@/pages/auth-page';
import { WorkspacePage } from '@/pages/workspace-page';
import { AdminPage } from '@/pages/admin-page';
import { AdminUsersPage } from '@/pages/admin-users-page';
import { AdminProvidersPage } from '@/pages/admin-providers-page';
import { NotFoundPage } from '@/pages/not-found-page';

export function App() {
  const { t } = useTranslation();
  return (
    <BrowserRouter>
      <SessionProvider>
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
              <Route element={<RequireAdmin />}>
                <Route
                  path="/admin"
                  element={
                    <AdminPage
                      title={t('nav.overview')}
                      description={t('admin.overviewDescription')}
                      icon={LayoutDashboard}
                    />
                  }
                />
                <Route
                  path="/admin/providers"
                  element={<AdminProvidersPage />}
                />
                <Route path="/admin/users" element={<AdminUsersPage />} />
                <Route
                  path="/admin/settings"
                  element={
                    <AdminPage
                      title={t('nav.settings')}
                      description={t('admin.settingsDescription')}
                      icon={Settings2}
                    />
                  }
                />
              </Route>
            </Route>
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
