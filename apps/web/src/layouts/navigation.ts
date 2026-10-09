import {
  LayoutDashboard,
  FileJson2,
  Plug,
  Settings2,
  Sparkles,
  TerminalSquare,
  Wrench,
  Users,
} from 'lucide-react';

export const adminNavigation = [
  { to: '/admin', label: 'nav.overview', icon: LayoutDashboard },
  { to: '/admin/providers', label: 'nav.providers', icon: Plug },
  { to: '/admin/tools', label: 'nav.tools', icon: Wrench },
  { to: '/admin/request-logs', label: 'nav.requestLogs', icon: FileJson2 },
  { to: '/admin/skills', label: 'nav.skills', icon: Sparkles },
  {
    to: '/admin/environment-variables',
    label: 'nav.environmentVariables',
    icon: TerminalSquare,
  },
  { to: '/admin/users', label: 'nav.users', icon: Users },
  { to: '/admin/settings', label: 'nav.settings', icon: Settings2 },
] as const;
