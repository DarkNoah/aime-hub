import { lazy, Suspense } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
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
const ProjectsPage = lazy(() =>
  import('@/pages/projects/page').then((m) => ({ default: m.ProjectsPage })),
);
const ProjectPage = lazy(() =>
  import('@/pages/projects/project-page').then((m) => ({
    default: m.ProjectPage,
  })),
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
const AdminToolsPage = lazy(() =>
  import('@/pages/admin/tools/page').then((m) => ({
    default: m.AdminToolsPage,
  })),
);
const AdminSkillsPage = lazy(() =>
  import('@/pages/admin/skills/page').then((m) => ({
    default: m.AdminSkillsPage,
  })),
);
const AdminEnvironmentVariablesPage = lazy(() =>
  import('@/pages/admin/environment-variables/page').then((m) => ({
    default: m.AdminEnvironmentVariablesPage,
  })),
);
const AdminRequestLogsPage = lazy(() =>
  import('@/pages/admin/request-logs/page').then((m) => ({
    default: m.AdminRequestLogsPage,
  })),
);
const NotFoundPage = lazy(() =>
  import('@/pages/errors/not-found-page').then((m) => ({
    default: m.NotFoundPage,
  })),
);

const rootRoute = createRootRoute({
  component: () => (
    <SessionProvider>
      <AvailableModelsProvider>
        <Suspense
          fallback={<LoadingState className="mx-auto mt-20 max-w-xl" />}
        >
          <Outlet />
        </Suspense>
      </AvailableModelsProvider>
    </SessionProvider>
  ),
  notFoundComponent: NotFoundPage,
});
const publicRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'public',
  component: PublicOnly,
});
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'session',
  component: RequireSession,
});
const layoutRoute = createRoute({
  getParentRoute: () => sessionRoute,
  id: 'layout',
  component: AppLayout,
});
const adminRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: 'admin',
  component: RequireAdmin,
});
// Keep the same project page mounted across draft and existing conversation routes.
const projectRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/projects/$projectId',
  component: ProjectPage,
});
const projectChatRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'threads',
});
const routeTree = rootRoute.addChildren([
  publicRoute.addChildren([
    createRoute({
      getParentRoute: () => publicRoute,
      path: '/login',
      component: () => <AuthPage key="login" mode="login" />,
    }),
    createRoute({
      getParentRoute: () => publicRoute,
      path: '/register',
      component: () => <AuthPage key="register" mode="register" />,
    }),
  ]),
  sessionRoute.addChildren([
    layoutRoute.addChildren([
      createRoute({
        getParentRoute: () => layoutRoute,
        path: '/',
        component: WorkspacePage,
      }),
      createRoute({
        getParentRoute: () => layoutRoute,
        path: '/threads',
        component: ThreadsPage,
      }),
      createRoute({
        getParentRoute: () => layoutRoute,
        path: '/threads/$threadId',
        component: ThreadsPage,
      }),
      createRoute({
        getParentRoute: () => layoutRoute,
        path: '/projects',
        component: ProjectsPage,
      }),
      projectRoute.addChildren([
        projectChatRoute.addChildren([
          createRoute({
            getParentRoute: () => projectChatRoute,
            path: '$threadId',
          }),
        ]),
      ]),
      adminRoute.addChildren([
        createRoute({
          getParentRoute: () => adminRoute,
          path: '/tools',
          component: AdminToolsPage,
        }),
        createRoute({
          getParentRoute: () => adminRoute,
          path: '/request-logs',
          component: AdminRequestLogsPage,
        }),
        createRoute({
          getParentRoute: () => adminRoute,
          path: '/',
          component: AdminOverviewPage,
        }),
        createRoute({
          getParentRoute: () => adminRoute,
          path: '/providers',
          component: AdminProvidersPage,
        }),
        createRoute({
          getParentRoute: () => adminRoute,
          path: '/users',
          component: AdminUsersPage,
        }),
        createRoute({
          getParentRoute: () => adminRoute,
          path: '/skills',
          component: AdminSkillsPage,
        }),
        createRoute({
          getParentRoute: () => adminRoute,
          path: '/environment-variables',
          component: AdminEnvironmentVariablesPage,
        }),
        createRoute({
          getParentRoute: () => adminRoute,
          path: '/settings',
          component: AdminSettingsPage,
        }),
      ]),
    ]),
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
