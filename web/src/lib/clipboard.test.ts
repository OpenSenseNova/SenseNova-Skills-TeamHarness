import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: originalClipboard,
  });
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: originalExecCommand,
  });
});

describe('copyText', () => {
  it('uses the Clipboard API when the browser provides it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    await expect(copyText('workspace-join-link')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('workspace-join-link');
  });

  it('copies through a temporary selection when Clipboard API is unavailable on LAN HTTP', async () => {
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    await expect(copyText('http://192.168.1.10/join/anc_example')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).not.toBeInTheDocument();
  });

  it('reports failure when neither copy path is allowed', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });

    await expect(copyText('workspace-join-link')).resolves.toBe(false);
  });
});
