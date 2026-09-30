/**
 * Theme selection, driven by the estate's Perspective theme packs.
 *
 * The IDE sits in a browser tab beside Perspective sessions wearing these same
 * ten themes, so the colours are DERIVED from `ignition-themes/packs/*.json`
 * rather than chosen here — see `tools/build-themes.py`, which also proves every
 * foreground token clears 3:1 against that theme's own page colour. That check
 * is not decoration: the themes repo shipped five illegible themes in v1.5.x by
 * trusting the palette instead of measuring it.
 *
 * The choice is per viewer and lives in localStorage, wrapped in try/catch —
 * a private window or a browser set to block site data throws on access, and a
 * theme picker must never be the thing that stops the IDE loading.
 */
import { useEffect, useState } from 'react';
import { THEMES, DEFAULT_THEME, type ThemeId } from '../themes';

const STORAGE_KEY = 'scriptide.theme';

export function readStoredTheme(): ThemeId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && THEMES.some((theme) => theme.id === stored)) {
      return stored as ThemeId;
    }
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return DEFAULT_THEME;
}

/** Apply a theme to the document root. Exported so the app can set it on boot. */
export function applyTheme(id: ThemeId) {
  document.documentElement.setAttribute('data-theme', id);
}

export default function ThemePicker() {
  const [theme, setTheme] = useState<ThemeId>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* the theme still applies for this session; it just will not be remembered */
    }
  }, [theme]);

  return (
    <label className="theme-picker">
      <span className="visually-hidden">Theme</span>
      <select
        value={theme}
        onChange={(event) => setTheme(event.target.value as ThemeId)}
        aria-label="Theme"
      >
        {THEMES.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
