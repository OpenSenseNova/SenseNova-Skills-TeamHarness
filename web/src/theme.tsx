import { MoonOutlined, SunOutlined } from '@ant-design/icons';
import { Button, ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark';

const THEME_STORAGE_KEY = 'anc:theme';

type ThemeModeContextValue = {
  mode: ThemeMode;
  isDark: boolean;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
};

const ThemeModeContext = createContext<ThemeModeContextValue>({
  mode: 'light',
  isDark: false,
  setMode: () => undefined,
  toggle: () => undefined,
});

function initialThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // Fall back to the OS preference when storage is unavailable.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(initialThemeMode);
  const isDark = mode === 'dark';

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Theme still applies for this session when storage is unavailable.
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark ? '#141414' : '#f5f7fa');
  }, [isDark, mode]);

  const contextValue = useMemo<ThemeModeContextValue>(() => ({
    mode,
    isDark,
    setMode,
    toggle: () => setMode((current) => current === 'dark' ? 'light' : 'dark'),
  }), [isDark, mode]);

  return (
    <ThemeModeContext.Provider value={contextValue}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            colorPrimary: '#4f6ef7',
            borderRadius: 10,
            colorBgLayout: isDark ? '#141414' : '#f5f7fa',
            fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif",
          },
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeModeContext.Provider>
  );
}

export function useThemeMode() {
  return useContext(ThemeModeContext);
}

export function ThemeToggleButton({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { isDark, toggle } = useThemeMode();
  const label = isDark ? '切换为浅色模式' : '切换为深色模式';
  return (
    <Button
      type={compact ? 'text' : 'default'}
      {...(className ? { className } : {})}
      icon={isDark ? <SunOutlined /> : <MoonOutlined />}
      aria-label={label}
      aria-pressed={isDark}
      title={label}
      onClick={toggle}
    >
      {!compact && label}
    </Button>
  );
}
