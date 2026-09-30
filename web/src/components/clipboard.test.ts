import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

/** Replace `navigator.clipboard`, returning a restore function. */
function withClipboard(value: unknown) {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  };
}

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses the async Clipboard API where it exists', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    restore = withClipboard({ writeText });
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back when navigator.clipboard is ABSENT, which is the HTTP case', async () => {
    // The regression this file exists for. The gateway is served over plain
    // HTTP, the async Clipboard API is gated on a secure context, so
    // `navigator.clipboard` is `undefined` — and the previous code called it
    // with `?.`, which is a silent no-op. Measured on the rig 03/09/2026: both
    // Copy buttons did nothing at all and said nothing about it.
    restore = withClipboard(undefined);
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    await expect(copyText('hello')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('falls back when the modern API exists but REJECTS', async () => {
    // A context that reports the API and then denies the permission. Giving up
    // there would be the same silent failure by a different route.
    restore = withClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    await expect(copyText('hello')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('reports failure rather than claiming success', async () => {
    // The caller shows a "Copied" confirmation. Saying so when nothing was
    // copied is worse than the button appearing not to work.
    restore = withClipboard(undefined);
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(false), configurable: true,
    });
    await expect(copyText('hello')).resolves.toBe(false);
  });

  it('leaves no textarea behind, even when the copy throws', async () => {
    restore = withClipboard(undefined);
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => { throw new Error('nope'); }), configurable: true,
    });
    const before = document.body.childElementCount;
    await expect(copyText('hello')).resolves.toBe(false);
    expect(document.body.childElementCount).toBe(before);
  });

  it('gives focus back, so copying does not steal the caret from the editor', async () => {
    restore = withClipboard(undefined);
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(true), configurable: true,
    });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    await copyText('hello');
    expect(document.activeElement).toBe(input);
    input.remove();
  });
});
