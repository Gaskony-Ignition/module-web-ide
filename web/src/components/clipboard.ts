/**
 * Copy text to the clipboard, including where `navigator.clipboard` does not exist.
 *
 * **This gateway is served over HTTP.** The async Clipboard API is gated on a
 * secure context, so on `http://<gateway>:8088` `navigator.clipboard` is
 * `undefined` — not "present and refuses", *absent*. A `navigator.clipboard?.`
 * optional call therefore does nothing at all, silently, and a Copy button that
 * silently does nothing is worse than no Copy button.
 *
 * Found by the live suite on 03/09/2026, on the very rig the module is
 * developed against: the unit tests passed because jsdom lets a test assign
 * `navigator.clipboard`, so the one environment that mattered was the one
 * nothing checked.
 *
 * The fallback is `document.execCommand('copy')` over an off-screen textarea.
 * It is deprecated and it is also the only thing that works here; it is used
 * ONLY when the modern API is missing or rejects.
 */

/** Put `text` on the clipboard. Resolves true when it actually got there. */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused, or a context that reports the API and then denies
      // it. Fall through rather than give up: the legacy path often still works.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const holder = document.createElement('textarea');
  holder.value = text;
  // Off-screen rather than hidden: `display:none` and `visibility:hidden`
  // elements cannot be selected, so the copy would silently take nothing.
  // `readOnly` stops a mobile keyboard appearing for the moment it is focused.
  holder.setAttribute('readonly', '');
  holder.style.position = 'fixed';
  holder.style.top = '-1000px';
  holder.style.opacity = '0';
  document.body.appendChild(holder);
  const previous = document.activeElement as HTMLElement | null;
  try {
    holder.select();
    holder.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(holder);
    // Give focus back, or copying from the ruler steals the caret out of the
    // editor and the next keystroke goes nowhere.
    previous?.focus?.();
  }
}
