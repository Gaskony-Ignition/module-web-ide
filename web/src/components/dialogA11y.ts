/**
 * A reusable dialog focus trap: Tab/Shift+Tab cycle within the dialog rather
 * than escaping to whatever sits behind the backdrop, Escape closes it, and
 * focus returns to whatever opened it once it unmounts. The exact pattern
 * `QueryHistoryDialog` already hand-wrote, factored out so a new dialog does
 * not reimplement it (and inevitably drift from it) by hand.
 */
import { useEffect, type KeyboardEvent, type RefObject } from 'react';

/** Elements Tab should cycle between while a dialog is open. */
export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])'
    )
  );
}

/**
 * Captures whatever had focus before the dialog mounted and restores it on
 * unmount; focuses `initial` (falling back to the dialog itself) once mounted.
 */
export function useDialogOpener(
  initial: RefObject<HTMLElement | null>,
  dialog: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initial.current ?? dialog.current)?.focus();
    return () => {
      opener?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only, by design
  }, []);
}

/** A dialog's `onKeyDown`: Escape closes it; Tab/Shift+Tab stay inside it. */
export function makeDialogKeyDown(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void
): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) {
      return;
    }
    const focusables = focusableElements(dialogRef.current);
    if (focusables.length === 0) {
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
}
