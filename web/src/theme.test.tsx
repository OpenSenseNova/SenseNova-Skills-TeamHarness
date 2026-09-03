import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider, ThemeToggleButton, useThemeMode } from './theme';

function ThemeStatus() {
  const { mode } = useThemeMode();
  return <span data-testid="theme-status">{mode}</span>;
}

describe('theme mode', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.dataset.theme = '';
  });

  it('toggles the global mode and persists the preference', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeStatus />
        <ThemeToggleButton compact />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('theme-status')).toHaveTextContent('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    await user.click(screen.getByRole('button', { name: '切换为深色模式' }));
    expect(screen.getByTestId('theme-status')).toHaveTextContent('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('anc:theme')).toBe('dark');
    expect(screen.getByRole('button', { name: '切换为浅色模式' })).toBeInTheDocument();
  });

  it('restores a stored mode on mount', () => {
    window.localStorage.setItem('anc:theme', 'dark');
    render(<ThemeProvider><ThemeStatus /></ThemeProvider>);
    expect(screen.getByTestId('theme-status')).toHaveTextContent('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
