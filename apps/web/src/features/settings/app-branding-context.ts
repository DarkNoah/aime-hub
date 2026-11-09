import { createContext, useContext } from 'react';

export const AppBrandingContext = createContext<{
  appName: string;
  updateAppName: (appName: string) => void;
} | null>(null);

export function useAppBranding() {
  const value = useContext(AppBrandingContext);
  if (!value) throw new Error('useAppBranding requires AppBrandingProvider');
  return value;
}
