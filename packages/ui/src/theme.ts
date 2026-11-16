/**
 * Theme mechanics (ADR 0018). The theme lives in `<html data-theme="light|dark">`, which is
 * always set before the first paint by `themeInitScript`; the tokens in `tokens.css` key off it.
 * The choice is stored per browser and per app (each app has its own origin).
 */
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "rondo-theme";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

/** The stored choice, or `null` when there is none or storage is unavailable. Never throws. */
export function readStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);

    return isTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Remembers a choice. Never throws: without storage the choice lasts until the page reloads. */
export function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage is not available (private mode, blocked site data): nothing to persist.
  }
}

export function getSystemTheme(): Theme {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** The theme in effect: the stored choice, else the system preference. */
export function resolveTheme(): Theme {
  return readStoredTheme() ?? getSystemTheme();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/**
 * Runs in `<head>` before the first paint (inline in `apps/app/index.html` and in the root layout
 * of `apps/docs`), so a dark theme never flashes light. It repeats `resolveTheme` + `applyTheme`
 * in ES5 with its own try/catch, because it cannot import anything. A test keeps the copy in
 * `apps/app/index.html` identical to this string (the formatter may only change whitespace, so
 * every statement already ends in `;`).
 */
export const themeInitScript =
  '(function(){var t=null;try{t=localStorage.getItem("rondo-theme");}catch(e){}if(t!=="light"&&t!=="dark"){t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.theme=t;})();';
