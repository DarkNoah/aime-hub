import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { THEME_STORAGE_KEY, ThemeContext, type Theme } from './context';

const systemQuery = '(prefers-color-scheme: dark)';

function parseTheme(value: string | null): Theme {
  return value === 'light' || value === 'dark' ? value : 'system';
}

function storedTheme(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

function subscribeToSystemTheme(onChange: () => void) {
  const media = window.matchMedia(systemQuery);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function systemIsDark() {
  return window.matchMedia(systemQuery).matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<Theme>(storedTheme);
  const darkSystem = useSyncExternalStore(
    subscribeToSystemTheme,
    systemIsDark,
    () => false,
  );
  const resolvedTheme =
    theme === 'system' ? (darkSystem ? 'dark' : 'light') : theme;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolvedTheme === 'dark');
    root.style.colorScheme = resolvedTheme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        'content',
        getComputedStyle(root).getPropertyValue('--background').trim(),
      );
  }, [resolvedTheme]);

  useEffect(() => {
    const syncPreference = (event: StorageEvent) => {
      if (
        event.storageArea === window.localStorage &&
        (event.key === THEME_STORAGE_KEY || event.key === null)
      ) {
        updateTheme(event.key === null ? 'system' : parseTheme(event.newValue));
      }
    };
    window.addEventListener('storage', syncPreference);
    return () => window.removeEventListener('storage', syncPreference);
  }, []);

  const setTheme = useCallback((nextTheme: Theme) => {
    updateTheme(nextTheme);
    try {
      if (nextTheme === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      return true;
    } catch {
      // Keep switching usable even when the browser blocks persistence.
      return false;
    }
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
