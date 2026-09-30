import { LayoutDashboard, Plug, Settings2, Users } from 'lucide-react';

export const adminNavigation = [
  { to: '/admin', label: 'nav.overview', icon: LayoutDashboard },
  { to: '/admin/providers', label: 'nav.providers', icon: Plug },
  { to: '/admin/users', label: 'nav.users', icon: Users },
  { to: '/admin/settings', label: 'nav.settings', icon: Settings2 },
] as const;
